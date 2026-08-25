# Getting the API off the laptop

Right now the backend runs on a laptop behind a Cloudflare quick tunnel. Close
the lid and the site is gone; restart the tunnel and its hostname changes and
has to be republished. This moves it somewhere that stays up.

The client already lives on Vercel and does not move.

Two accounts, both free, both yours to create — I cannot make accounts:

| What | Where | Why |
|---|---|---|
| Postgres | [neon.tech](https://neon.tech) | The database, managed and backed up |
| The API | [render.com](https://render.com) | Runs the Docker image, gives it a fixed address |

---

## 1. Neon

Create a project, then copy the **pooled** connection string — it looks like
`postgresql://user:pass@ep-something-pooler.region.aws.neon.tech/neondb?sslmode=require`.

Pooled, not direct: the API opens a connection per instance and Neon's direct
endpoint has a low ceiling. The pooled one is what survives more than one
visitor.

Keep it to hand for step 2. Do not paste it anywhere else — it is a password.

## 2. Render

**New → Blueprint → this repository.** Render reads `render.yaml` and asks for
four values. Everything else is already in that file.

| Setting | Value |
|---|---|
| `DATABASE_URL` | the Neon string from step 1 |
| `JWT_SECRET` | 32+ random characters, see below |
| `UPI_ID` | `8982364069@ptsbi` |
| `ADMIN_EMAILS` | `nikhileshdubey039@gmail.com` |

Generate the secret yourself and do not reuse the local one:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | % { [char]$_ })
```

Changing `JWT_SECRET` later signs everyone out at once, so set it once and
leave it.

The first build takes several minutes: it installs dependencies, generates the
Prisma client, compiles, and downloads 26 MB of inference weights. Migrations
run on every boot, which is a no-op once they are applied.

When it finishes, Render shows a URL like `https://omextv-api.onrender.com`.
That address does not change.

## 3. Point the client at it

```powershell
powershell -File scripts/use-api.ps1 -Url "https://omextv-api.onrender.com"
```

That rewrites `runtime-config.json` and pushes it. The deployed client reads it
at boot, so no rebuild is needed and no tunnel is involved.

## 4. Stop the laptop pieces

Once the site works against Render, none of this is needed any more:

```powershell
Get-Process cloudflared -EA SilentlyContinue | Stop-Process -Force
Get-Process powershell | Where-Object { $_.Id -ne $PID } | Stop-Process -Force
```

`scripts/tunnel.ps1`, `scripts/watch-tunnel.ps1` and the DNS workarounds all
exist because the API had no fixed address. They stay in the repo in case it
ever moves again, but nothing needs to run.

---

## What the free plan costs you

**The instance stops after fifteen idle minutes** and takes about a minute to
start on the next request. That is the real trade for paying nothing, and it
lands hardest here: this app needs two people at once, and the first one waits.

The client handles it rather than hiding it — a slow request shows "Waking the
server up… (12s)" instead of an error, the socket keeps retrying for two
minutes instead of five seconds, and requests wait ninety seconds instead of
timing out. Someone who reads that message waits. Someone who sees a broken
page leaves.

If that stops being acceptable, Render's Starter plan is about $7 a month and
does not sleep. A small VPS is similar money and would also give you a TURN
relay on the same box, which is the other thing still missing.

## What this does not fix

**Calls between different networks still fail.** TURN has nothing to do with
where the API runs. Two people on different mobile networks still cannot reach
each other, and that is the largest remaining problem with the product — see
`scripts/set-turn.ps1`.

**Free Postgres has limits.** Neon's free tier is generous but finite. The
admin page reports account and order counts; watch them.

**512 MB of RAM.** The weights are ~26 MB and onnxruntime is not small. If the
service restarts on its own shortly after boot, set `GENDER_PROVIDER=mock` in
Render — camera verification stops working, nothing else does.

## Checking it

```powershell
powershell -File scripts/status.ps1 -ApiUrl "https://omextv-api.onrender.com"
```

Or open `https://omextv.vercel.app/admin`, which says what is wrong in words.
The first request will be slow if the instance was asleep. That is the point.
