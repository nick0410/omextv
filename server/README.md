---
title: Omextv API
emoji: "📹"
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 3001
pinned: false
---

<!--
The block above is Hugging Face Spaces metadata; it is ignored everywhere else.
`app_port` must match the port the server listens on, and Spaces run the
container as uid 1000 — which is the `node` user the Dockerfile already
switches to.

A Space has no Redis, so REDIS_URL is left unset and the in-memory store is
used. That limits the API to a single instance, which is what the free tier
runs anyway.
-->

# Omextv — Backend

Random 1-on-1 video chat. Node + Express + Socket.io + Prisma/Postgres, with Redis for shared state.

Video itself never touches this server: WebRTC carries it peer-to-peer. The
backend does matchmaking, signalling relay, text chat, moderation, and gender
inference.

---

## Matchmaking

### The queue

Two FIFO lanes — `premium` and `standard` — each an intrusive doubly-linked
list with an id index (`services/matchmaking/queue.ts`).

| Operation | Cost |
|---|---|
| enqueue | O(1) |
| dequeue | O(1) |
| remove by userId | O(1) |
| scan for a compatible partner | O(n) |

Premium waiters are scanned first, so they wait less. **Within** a lane the
oldest compatible waiter always wins — a newcomer can never jump ahead of
someone who has been waiting longer and is equally compatible.

Re-joining the queue (e.g. after changing filters) keeps your original
position. Without that, spamming "join" would be a way to jump the line.

### Atomicity

`MatchmakingEngine.joinQueue` is **fully synchronous**. On a single-threaded
runtime that makes each call atomic: two users joining at the same instant
cannot interleave and be handed the same partner.

This is why `blockedIds` and `recentPartners` are snapshotted into the queue
entry *before* matching starts — the matcher can never `await` mid-scan.

### Compatibility

A pair forms only if **both** sides accept each other:

- **Blocks** — never matched, in either direction, at any stage.
- **Gender** — the seeker's `gender` preference vs. the candidate's
  *effective* gender (see below), and vice versa.
- **Country** — ISO 3166-1 alpha-2, exact match against the filter list.
- **City** — only meaningful with exactly one country selected.
- **Recent partners** — you are not rematched with someone you just left.

### Relaxation ladder

A user who has waited a while gets *some* rules loosened. Country and gender
are **never** relaxed — being handed the wrong continent because the queue was
slow is a bug, not a feature.

| Stage | After | Rematch window | City enforced |
|---|---|---|---|
| 0 | 0s | 30 min | yes |
| 1 | 20s | 5 min | no |
| 2 | 60s | disabled | no |

When two users have waited different amounts, the **more generous** stage
applies — otherwise a long waiter stays stuck behind a stream of strict
newcomers.

A background sweep (`MATCH_SWEEP_INTERVAL_MS`, default 2s) re-evaluates
everyone waiting, oldest first. Without it, crossing a stage threshold would
never actually trigger a re-check.

---

## Gender inference

> **A caveat that shapes the whole design.** A vision model cannot observe
> gender, only appearance. It misreads trans and non-binary people by
> construction, and accuracy varies with lighting, angle, skin tone and age.
> It is treated here as a *signal*, never as truth.

Rules that follow from that:

- the model can only output `male` / `female` / `unknown` — never `other`;
- a reading below `GENDER_CONFIDENCE_THRESHOLD` is discarded entirely;
- a user who declared `other` is **never** overwritten;
- a disagreement sets a `genderMismatch` flag for moderation — it does not
  auto-ban or auto-correct;
- self-declared gender is the fallback whenever verification is missing,
  stale, or low-confidence.

### Whose face?

The frame is of the **caller's own** camera. Video is peer-to-peer so the
server never sees the remote stream, and letting a peer classify the person
they are talking to would let anyone forge a label for someone else.

### Effective gender

What everyone else's filters are tested against:

```
declared == "other"                → "other"        (never overridden)
fresh AND confident AND male/female → verified value
otherwise                          → declared value
```

"Fresh" means within `GENDER_FRESHNESS_HOURS` (default 24).

### Providers

Selected by `GENDER_PROVIDER`. All implement the same interface, so swapping is
one env var.

| Provider | What it does | Status |
|---|---|---|
| `mock` | Deterministic hash of the image bytes. **Does not look at the picture.** | Works, test-only |
| `onnx` | Local two-stage: UltraFace detector → GoogLeNet gender classifier | **Working, default** |
| `http` | POSTs the frame to a hosted inference endpoint | Code complete, needs an endpoint |

`@tensorflow/tfjs-node` was tried first and **cannot be installed on Windows
without Visual Studio C++ build tools** — `node-gyp` fails at the native build
step. `onnxruntime-node` ships prebuilt binaries and installs cleanly, which is
why the local provider is built on it.

Falling back to `mock` is logged loudly — silently degrading to a hash-based
guess in production would be worse than a crash.

#### Getting the weights

```bash
npm run models:fetch                 # ~2.6 MB, checksum-verified
npm run models:fetch -- --fixtures   # plus sample images for the tests
npm run gender:check                 # smoke-test the pipeline
npm run gender:check photo1.jpg …    # run on photos you know
```

| File | Model | Size |
|---|---|---|
| `detector.onnx` | UltraFace RFB-320 ([ONNX Model Zoo](https://github.com/onnx/models), Apache 2.0) | 1.21 MB |
| `genderage.onnx` | InsightFace `genderage`, buffalo_l pack | 1.26 MB |

#### Which classifier

`GENDER_CLASSIFIER` picks the architecture; it drives input size, channel
order, normalization, crop padding, and which output index means which gender.

| | `insightface` (default) | `googlenet` |
|---|---|---|
| Size | 1.26 MB | 23 MB |
| Input | 96x96, RGB, raw 0-255 | 224x224, BGR, mean [104,117,123] |
| Crop | squared box, 1.5x | squared box, no padding |
| Output order | `[female, male]`, logits | `[male, female]`, pre-softmaxed |
| Extra | age estimate | — |
| **On the 19-face group photo** | **19/19** | 17/19 |

The GoogLeNet model (Levi & Hassner, Adience, 2015) is kept only for
comparison. Its published accuracy is around 86% and that is exactly what it
delivers — it labels two of the nineteen men women, confidently enough to clear
the threshold. That is not a preprocessing bug to be tuned away; it is the
model's ceiling. Swapping in InsightFace is what actually fixed it.

Two preprocessing details worth recording, because both fail *silently*:

- **Channel order.** The GoogLeNet card says BGR while the repository's own
  reference script converts to RGB and subtracts the BGR-ordered mean. The card
  is right. Following the script does not crash — it just degrades the model.
- **Squaring the box.** The classifier takes a square input; stretching a tall
  detector box into it distorts exactly the face geometry the model reads.

#### Measured behaviour

| Input | Result |
|---|---|
| 19-person group photo | 19/19 correct, both women identified |
| Blank/noise frame | `unknown`, 0 faces — no false positive |
| Crowd of small background faces | 0 faces — all under `GENDER_MIN_FACE_AREA` |
| Non-image bytes | `unknown`, no throw |

Model load ~0.3 s; inference ~100-500 ms per frame on CPU.

#### Why several frames, not one

A single webcam still is a noisy sample. Blink, turn slightly, or let a shadow
fall across half your face, and a face near the decision boundary flips between
readings. Classifying one frame and treating it as final is what makes the
result look random.

The client sends seven frames over roughly 1.5 s. The server averages the
per-frame probabilities rather than counting votes, so a run of hesitant 0.51
readings cannot outvote a couple of confident 0.97 ones, and separately tracks
`agreement` — the fraction of frames that picked the winner:

| Condition | Outcome |
|---|---|
| agreement < `minAgreement` (0.7) | `unstable` — nothing is stored |
| confidence < threshold | `low_confidence` |
| would flip a stored verdict by less than `flipMargin` | `unstable` |
| otherwise | `accepted` |

The whole batch costs **one** rate-limit token; charging per frame would push
clients back to the single-shot behaviour this replaces.

Hysteresis stops a stored label oscillating between attempts, but the bar it
sets is capped at `flipCeiling` (0.95). Without that cap a stored 0.92 would
demand 1.02 to overturn — which no softmax can produce — so a user the model
had misread once could never correct it.

### Abuse guards

- 10 verification attempts per 5 minutes per user (token bucket).
- Image type is sniffed from magic bytes; the client's MIME claim is ignored.
- Base64 length is checked *before* allocation, so an oversized payload cannot
  be decoded into memory.
- Frames with 0 or >1 face are rejected — a reading cannot be attributed.
- Decoded images over 40 MP are refused (decompression bombs).
- Every attempt increments `genderAttempts`, accepted or not.

---

## Connections

### One socket per account

A second connection for the same user **evicts the first** (`session-replaced`,
then disconnect). Pairing state is keyed by userId, so two live sockets for one
account would let the second tab hijack the first tab's chat and let either
disconnect tear down the other's state.

A late teardown from an already-evicted socket does not clear the newer
session's record.

### Reconnect grace

Losing a socket mid-chat does not end the conversation. The partner gets
`partner-connection-lost` and the room is held for `RECONNECT_GRACE_MS`
(default 8s). Reconnecting inside that window emits `chat-resumed` to the
returning user and `partner-reconnected` to the other. Otherwise the chat ends
with reason `disconnect`.

### Room security

Room membership is checked against the server's own pairing registry, not
against socket.io rooms. Previously a client could emit into any roomId it
guessed and inject signalling or messages into strangers' calls.

---

## Socket API

**Client → server**

| Event | Payload | Notes |
|---|---|---|
| `join-queue` | `{ gender?, countries?, city? }` | Invalid filters are coerced, not rejected |
| `leave-queue` | — | |
| `offer` / `answer` / `ice-candidate` | `{ roomId, ... }` | Membership enforced |
| `chat-message` | `{ roomId, text }` | Trimmed, truncated to `MAX_MESSAGE_LENGTH` |
| `typing` | `{ roomId, isTyping }` | |
| `skip` / `end-chat` | `{ roomId }` | |
| `verify-gender` | `{ image }` | base64 or data URL; supports an ack callback |
| `queue-status` | — | |

**Server → client**

| Event | When |
|---|---|
| `connected` | Immediately on connect |
| `queue-joined` / `queue-left` / `queue-requeued` / `queue-error` | Queue lifecycle |
| `match-found` | `{ roomId, isInitiator, partner, waitedMs, relaxStage }` |
| `offer` / `answer` / `ice-candidate` | Relayed from the partner |
| `chat-message` / `typing` | |
| `partner-left` / `partner-connection-lost` / `partner-reconnected` | |
| `chat-ended` / `chat-resumed` | |
| `signal-rejected` / `message-rejected` | Rejected with a `code` |
| `gender-verified` | Verification result |
| `session-replaced` | Signed in elsewhere |
| `server-shutdown` | Graceful shutdown |

Exactly one side of a match gets `isInitiator: true`, so the two peers cannot
both create an offer and glare.

`match-found` carries a **public profile only** — never the partner's email.

---

## HTTP API

```
GET    /health
GET    /api/online                    { count }
GET    /api/stats                     queue/chat/provider telemetry

POST   /api/auth/register|login       GET /api/auth/me
GET    /api/user/profile              PATCH /api/user/profile

POST   /api/report                    ends the chat, may auto-suspend
POST   /api/report/block              idempotent
DELETE /api/report/block/:id
GET    /api/report/blocks

GET    /api/meta/countries            valid ISO codes
GET    /api/meta/countries/online     countries with someone online
POST   /api/meta/verify-gender        HTTP twin of the socket event
GET    /api/meta/gender-status        caller's verification state

GET    /api/rtc/ice-servers           STUN/TURN config
```

An unmatched `/api/*` returns JSON 404 rather than falling through to the SPA
shell.

---

## Rate limits

Token buckets, refilled continuously rather than reset on a window — a fixed
window lets a client burst 2x the limit by straddling the boundary. Keyed by
userId, so reconnecting does not reset the budget.

| Limit | Default |
|---|---|
| Queue joins | 30/min |
| Chat messages | 60/min |
| WebRTC signals | 600/min |
| Gender verification | 10 / 5 min |

Single-process only. Behind multiple instances these need to move to Redis; the
`RateLimiter` interface is narrow so that swap is contained.

---

## Running

```bash
npm install
cp .env.example .env
npx prisma db push
npm run dev          # :3001
```

SQLite paths resolve relative to `prisma/`, so `DATABASE_URL="file:./dev.db"`
means `server/prisma/dev.db`.

---

## Tests

```bash
npm test              # once
npm run test:watch
npm run test:coverage
```

Integration tests run against a **copy** of `dev.db` (`prisma/test.db`), made
fresh in `src/__tests__/setup.ts`, so they can never touch real data.

Covered: FIFO ordering and O(1) removal under 10k operations, mid-walk mutation,
two-way filter matching, relaxation stages, what relaxation must never touch,
premium priority, no double-booking across 500 concurrent joins, token-bucket
refill and clock-jump handling, single-session eviction, pairing lifecycle,
recent-partner eviction, image sniffing and payload limits, NMS and box maths,
softmax overflow, every gender-verification outcome, and the full socket flow
end to end — auth, bans, matching, filters, room-injection attempts, skip,
disconnect, and reconnect.

---

## Scaling

All shared state sits behind one interface (`services/store/types.ts`) with two
implementations:

| | `memory` | `redis` |
|---|---|---|
| Selected by | `REDIS_URL` unset | `REDIS_URL` set |
| Queue, presence, pairing | in-process Maps | Redis keys with TTLs |
| Matchmaking lock | no-op (runtime is already single-threaded) | `SET NX PX` + owner-checked release |
| Cross-instance delivery | n/a | pub/sub bus |

Both are run against the **same contract test suite**, so switching backends
cannot change behaviour. That suite caught a genuine divergence: the in-memory
queue ordered by insertion while Redis ordered by `joinedAt` score, and the
memory implementation dropped a re-joining user to the back of the line.

Things worth knowing:

- **Fail loud, not quiet.** `REDIS_URL` set but unreachable aborts startup. A
  cluster silently splitting into isolated islands — each with its own queue,
  so users on different nodes can never meet — is a far worse failure.
- **`/health` returns 503** when the store is unreachable, so a node that
  cannot see the shared queue is pulled from the load balancer.
- **Presence entries carry a TTL** refreshed by heartbeat, so a crashed
  instance's users expire instead of showing as permanently online.
- **Queue entries are hand-serialised.** `QueueEntry` holds a `Set` and a
  `Map`; `JSON.stringify` turns both into `{}` silently, which would drop every
  block and every recent partner on a Redis round-trip.

## TURN

Ephemeral credentials via the coturn REST API convention:

```
username   = "<unix-expiry>:<userId>"
credential = base64(HMAC-SHA1(username, TURN_SECRET))
```

The server stores no per-user state — it recomputes the HMAC from the username
it is handed. Shipping one fixed TURN username and password to every browser
means anyone who opens devtools can point their own traffic at your relay, and
relay bandwidth is the expensive part of running TURN.

Long-lived `TURN_SERVER_USERNAME`/`TURN_SERVER_CREDENTIAL` are still supported
because many hosted providers only offer those. A TURN URL with no credentials
at all is dropped from the ICE list rather than sent, since the browser would
silently ignore it and `hasTurn` would lie.

`GET /api/rtc/ice-servers` is authenticated and `no-store`.

## Known gaps

- **No TURN server is actually deployed.** The code issues credentials for one,
  but you still need to run coturn on a host with a public IP (or buy hosted
  TURN). Without it, ~10-15% of calls will not connect.
- **Gender model weights** are not bundled — see above.
- **Country is self-declared**, not verified against GeoIP.
- **Socket.io still needs its Redis adapter** for room broadcasts to span
  instances. Direct-to-user events already cross instances via the bus, but
  `io.to(roomId)` only reaches sockets on the local node.
- **Class order is unverified against labelled photos.** It matches the model
  reference script; confirm with `npm run gender:check <photos>`.
