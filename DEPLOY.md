# Deploying Omextv

> **Running it publicly right now, for free, with no card:** see
> [Quick tunnel](#quick-tunnel-no-account-no-card) below. That is what is live
> today — the frontend on Vercel talking to the API on your own machine.

Two hosts, because the two halves need different things:

| Part | Host | Why |
|---|---|---|
| Frontend (`client/`) | Vercel | Static SPA, already live at https://omextv.vercel.app |
| Backend (`server/`) | Render | Needs persistent WebSockets and a long-lived process |

**The API cannot run on Vercel.** Socket.io holds an open WebSocket per user,
the matchmaking sweep runs on a timer, and the ONNX model stays resident in
memory. Serverless functions provide none of that.

---

## 1. Backend on Render

Everything is described in `render.yaml`, so Render creates the database, the
Redis instance and the API service and wires them together itself.

### Push the code somewhere Render can read

Render deploys from GitHub, GitLab or Bitbucket. The repo is committed locally
but has no remote yet:

```bash
cd video_chat
gh repo create omextv --private --source=. --push
# or, without the gh CLI: create an empty repo on github.com, then
git remote add origin https://github.com/<you>/omextv.git
git push -u origin main
```

Nothing sensitive is committed — `.env`, the SQLite files and the model
weights are all gitignored. Verify before pushing if you want:

```bash
git ls-files | grep -E "\.env$|\.onnx$|\.db$"   # should print nothing
```

### Create the blueprint

Render dashboard → **New** → **Blueprint** → pick the repo → Apply.

That creates:

- `omextv-postgres` — Postgres 16, free plan
- `omextv-redis` — Key Value store, free plan, `allkeys-lru`
- `omextv-api` — Docker web service from `server/Dockerfile`

`DATABASE_URL`, `REDIS_URL` and `JWT_SECRET` are filled in automatically.

### Set the two things Render cannot guess

In the `omextv-api` service → Environment:

| Variable | Value |
|---|---|
| `CLIENT_URL` | `https://omextv.vercel.app` |
| `TURN_SERVER_URL` | your TURN server, e.g. `turn:1.2.3.4:3478` |
| `TURN_SECRET` | the coturn `static-auth-secret` |

`CLIENT_URL` is not optional — CORS rejects the frontend without it.

Database migrations run automatically on every boot (`prisma migrate deploy`
in the start command); already-applied migrations are a no-op.

---

## 2. Point the frontend at the API

Vercel project `omextv` → Settings → Environment Variables:

```
VITE_API_URL     = https://omextv-api.onrender.com
VITE_SOCKET_URL  = https://omextv-api.onrender.com
```

Then redeploy — Vite bakes these at **build** time, so changing the variable
without rebuilding does nothing:

```bash
cd client && npx vercel deploy --prod
```

---

## 3. TURN

STUN alone fails whenever both peers are behind symmetric NAT — commonly
10-15% of connections, worse on corporate and mobile networks. Those calls
only connect through a relay.

Render cannot host coturn: it needs a wide UDP port range that Render does not
expose. Options:

- **coturn on a small VPS** (~$5/mo). `docker-compose.yml` has a `turn`
  profile; set `TURN_EXTERNAL_IP` to the VPS public address and open UDP 3478
  plus 49160-49200.
- **A hosted provider** — Twilio, Metered, Cloudflare Calls. Most only issue
  long-lived credentials, which the server supports via
  `TURN_SERVER_USERNAME` / `TURN_SERVER_CREDENTIAL`.

With `TURN_SECRET` set the server issues short-lived per-user HMAC credentials
instead, which is the better option where the provider supports it.

---

## Free tier caveats

Worth knowing before treating this as production:

- **Render free web services sleep after 15 minutes of inactivity.** For a
  chat app that means the first visitor after a quiet spell waits ~50s for a
  cold start, and any WebSocket open at sleep time is dropped. The queue and
  presence live in Redis so they survive, but active calls do not.
- **Free Postgres expires.** Render's free databases are time-limited; back up
  or upgrade before the deadline.
- **One instance.** Redis is wired up so multiple instances work, but the free
  plan runs one. Scaling up needs no code change — just more instances.

---

## Verifying a deployment

```bash
curl https://omextv-api.onrender.com/health
# {"status":"ok","store":"redis","storeOk":true,...}

curl https://omextv-api.onrender.com/api/stats
# genderProvider should be "onnx", not "mock"
```

If `store` is `memory`, `REDIS_URL` did not reach the service. If
`genderProvider` is `mock`, the model weights are missing from the image —
check the `fetch-models` step in the build log.

---

## Quick tunnel (no account, no card)

The fastest way to make the local API reachable from the deployed frontend:

```powershell
powershell -File scripts/tunnel.ps1
```

That starts a Cloudflare quick tunnel, waits for it to actually serve, updates
`VITE_API_URL`/`VITE_SOCKET_URL` on Vercel, and rebuilds the frontend against
the new hostname.

Two things the script exists to get right:

- **`--protocol http2`.** The default is QUIC over UDP, which plenty of
  networks block. The symptom is nasty: the tunnel connects, serves a handful
  of requests, then drops into an endless `Retrying connection` loop while the
  hostname keeps resolving — so the site looks up but every call fails.
- **`--force` on the deploy.** Only the environment changed, so Vercel would
  otherwise reuse the cached build and ship the previous, now-dead URL.

### What it costs you

Nothing, but the tunnel only lives as long as the process and the laptop. The
hostname is random and changes on every restart, and because Vite bakes the
API URL in at build time, a restart means a rebuild — hence the script.

For something that stays up without your machine, use the Render blueprint
above, or a free Docker host plus a hosted Postgres.
