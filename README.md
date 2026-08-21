# ✨ Omextv — Random 1v1 Video Chat

Omegle-style random video chat. Users are paired 1-on-1 over WebRTC, can filter
by country and gender, and wait in a fair FIFO queue. Gender can be verified
automatically from a camera frame rather than taken on trust.

> **Status:** backend and frontend both working end to end, on Postgres + Redis
> with real local gender inference.

## 🚀 Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Node.js, Express, TypeScript, Socket.io |
| **Database** | PostgreSQL + Prisma ORM |
| **Real-time** | Socket.io signalling, WebRTC peer-to-peer video |
| **Auth** | JWT + bcrypt |
| **Vision** | onnxruntime-node — UltraFace detector + GoogLeNet gender classifier |
| **Scaling** | Redis — shared queue, presence, pairing + cross-instance bus |
| **Frontend** | React 19, TypeScript, Vite 8, Tailwind v4 |
| **Tests** | Vitest — 403 unit, integration and real-model tests |
| **Payments** | Razorpay (INR) |

## 📁 Structure

```
├── server/                     # Express backend — see server/README.md
│   ├── prisma/schema.prisma    # User, ChatSession, Block, Report, Payment
│   └── src/
│       ├── config/             # env, database, ISO country list
│       ├── middleware/         # JWT auth
│       ├── routes/             # auth, user, report+block, premium, rtc, meta
│       ├── services/
│       │   ├── matchmaking/    # FIFO queue + matching engine
│       │   ├── gender/         # provider interface, ONNX, HTTP, mock
│       │   ├── socket.ts       # connection lifecycle, signalling, chat
│       │   ├── presence.ts     # who is online, one socket per account
│       │   └── pairing.ts      # active chats, recent partners, persistence
│       ├── utils/              # validation, rate limiter, auth helpers
│       └── __tests__/          # unit + end-to-end socket tests
└── client/                     # React frontend (shell only right now)
```

## 🏃 Quick Start

Node 20+.

```bash
# Infrastructure
docker compose up -d postgres redis

# Backend
cd server
npm install
cp .env.example .env
npx prisma db push
npm run models:fetch     # ~24 MB of gender-inference weights
npm run dev              # :3001

# Frontend
cd client
npm install
npm run dev              # :5173
```

## 🔑 Features

**Matchmaking**
- True FIFO queue — O(1) enqueue, dequeue and removal
- Two lanes: premium waiters served first, FIFO preserved within each
- Two-way filter matching — both people must accept each other
- Country (ISO 3166-1) and gender filters, available to every user
- Progressive relaxation for long waits — but country and gender are **never**
  relaxed, only rematch-avoidance and the city sub-filter
- No instant rematch with someone you just skipped
- Atomic matching: no double-booking under concurrent joins

**Gender verification**
- Real local inference: UltraFace finds the face, GoogLeNet classifies it
- **Multi-frame**: seven frames over ~1.5s, averaged. One webcam still is a
  noisy sample and flips between male and female; disagreeing frames return
  "unstable" rather than a confident-looking coin flip
- Hysteresis stops a stored verdict oscillating between attempts
- The server classifies a frame of *your own* camera and stores the verdict
- Matching uses the verified value when it is fresh and confident, else the
  self-declared one
- A self-declared "other" is never overridden by the model
- Pluggable providers: local ONNX, hosted HTTP, or a deterministic mock

**Chat & safety**
- WebRTC peer-to-peer video with STUN/TURN support
- Text chat, typing indicators, skip / end
- Reports with categories, persistent blocks, automatic suspension threshold
- Reconnect grace period — a refresh does not end the conversation
- One live session per account
- Per-user rate limits on queueing, messages and signalling

## 📝 Environment

Full documented list in `server/.env.example`. The essentials:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite path, resolved relative to `prisma/` |
| `JWT_SECRET` | Refuses to boot in production if left at the default |
| `CLIENT_URL` | Frontend origin for CORS |
| `GENDER_PROVIDER` | `mock` \| `onnx` \| `http` |
| `GENDER_CONFIDENCE_THRESHOLD` | Below this, a reading is discarded (default 0.75) |
| `TURN_SERVER_URL` | Needed for users behind symmetric NAT |

## 🧪 Tests

```bash
cd server
npm test
npm run test:coverage
```

Integration tests run against a throwaway copy of the dev database, so they can
never touch real data.

## Frontend

Rebuilt from scratch. Landing, sign in/up, and a single chat screen with the
video stage, controls, filters, camera verification and text chat.

State lives in one `useCall` hook rather than split across separate
matchmaking/signalling/peer hooks — a `match-found` has to drive an offer, a
`partner-left` has to tear the peer connection down, and a skip has to do both
in order. Keeping them together makes that ordering enforceable.

## Deployment notes

- **Redis** is required for more than one instance. Without `REDIS_URL` each
  node keeps its own queue and two users on different nodes can never meet.
  With it set but unreachable, the server refuses to boot rather than silently
  splitting the cluster into islands.
- **TURN**: STUN alone fails for ~10-15% of users behind symmetric NAT. Set
  `TURN_SERVER_URL` + `TURN_SECRET` (coturn REST API) — clients then get
  short-lived per-user HMAC credentials instead of a shared password.
  `docker compose --profile turn up -d coturn` runs one locally, though it only
  serves the LAN unless `TURN_EXTERNAL_IP` is a real public address.
- **Model weights** are not committed: `npm run models:fetch` in `server/`.
  Without them the provider falls back to `mock`, which does not look at the
  image at all.

## 📄 License

MIT
