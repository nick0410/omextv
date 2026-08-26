import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";

/**
 * Where the untouched webhook body is kept.
 *
 * Declared against IncomingMessage rather than Express's Request because the
 * body parser's verify hook runs before Express has wrapped it.
 */
export type WithRawBody = { rawBody?: Buffer };
import cookieParser from "cookie-parser";
import path from "path";

import { env } from "./config/env";
import { prisma } from "./config/database";
import { setupSocket, getOnlineCount, getStats, shutdownSocket } from "./services/socket";
import { genderService, createGenderProvider } from "./services/gender/service";
import { initStores, closeStores, stores } from "./services/store";
import { warnIfNoTurn } from "./services/turn";
import { apiLimiter } from "./middleware/rateLimit";

import authRoutes from "./routes/auth";
import userRoutes from "./routes/user";
import reportRoutes from "./routes/report";
import premiumRoutes from "./routes/premium";
import coinRoutes from "./routes/coins";
import adminRoutes from "./routes/admin";
import rtcRoutes from "./routes/rtc";
import metaRoutes from "./routes/meta";

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

/*
 * Security headers.
 *
 * `contentSecurityPolicy` is off because this process also serves the built
 * client in single-host deployments, and a default CSP breaks Vite's inline
 * module preload. `crossOriginResourcePolicy` is relaxed for the same reason
 * the CORS list exists: the frontend is served from a different origin.
 *
 * Express also advertises itself in every response by default, which tells an
 * attacker which CVE list to start from for no benefit to anyone.
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.disable("x-powered-by");

app.use(
  cors({
    origin: env.IS_PROD ? [env.CLIENT_URL, ...env.ALLOWED_ORIGINS] : true,
    credentials: true,
  }),
);
// Gender frames are base64 and can approach the 2 MB decoded cap.
/*
 * Keep the untouched bytes of a webhook body.
 *
 * A gateway signs exactly what it sent. Re-serialising the parsed JSON
 * reorders keys and changes whitespace, so the digest stops matching and every
 * genuine webhook is rejected — which fails safe but silently stops all
 * automatic crediting, and looks like the gateway never called.
 *
 * Only for the webhook paths: stashing a copy of every request body would mean
 * holding a second copy of each 6 MB frame of camera data.
 */
app.use(
  express.json({
    limit: "6mb",
    verify: (req, _res, buf) => {
      if (req.url?.startsWith("/api/coins/webhook/")) {
        (req as typeof req & WithRawBody).rawBody = Buffer.from(buf);
      }
    },
  }),
);
app.use(cookieParser());

/**
 * Is this instance able to do its job?
 *
 * Both dependencies count. A dead Redis means the node cannot see the shared
 * queue; a dead database means nobody can sign in, no session is recorded and
 * no report is stored. This used to check only the store, so with Postgres
 * down it cheerfully reported "ok" while every login returned a 500 — exactly
 * the outage a health check exists to catch.
 *
 * Each probe is bounded: a hung dependency must not hang the endpoint that is
 * supposed to report it as hung.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

app.get("/health", async (_req, res) => {
  const store = stores();

  const [storeOk, dbOk] = await Promise.all([
    withTimeout(store.ping(), 3000, false),
    withTimeout(
      prisma.$queryRaw`SELECT 1`.then(
        () => true,
        () => false,
      ),
      3000,
      false,
    ),
  ]);

  const healthy = storeOk && dbOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    name: "Omextv API",
    version: "2.1.0",
    store: store.kind,
    storeOk,
    dbOk,
  });
});

app.get("/api/online", async (_req, res) => {
  res.json({ count: await getOnlineCount() });
});

app.get("/api/stats", async (_req, res) => {
  res.json(await getStats());
});

// Applied to /api only: /health has to stay answerable for the deploy scripts,
// and the static client below should not be throttled.
app.use("/api", apiLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/report", reportRoutes);
app.use("/api/premium", premiumRoutes);
app.use("/api/coins", coinRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/rtc", rtcRoutes);
app.use("/api/meta", metaRoutes);

// An unmatched /api/* must 404 as JSON, not fall through to the SPA shell —
// otherwise a typo'd endpoint returns 200 text/html and the client parses
// index.html as a response body.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const clientDist = path.join(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) res.status(404).json({ error: "Not found" });
  });
});

/*
 * Express error handler. Must come last and take four args to be recognised.
 *
 * The distinction it draws is between a request that was wrong and a server
 * that was: a truncated body, or one that is not an object, is the client's
 * mistake and answering 500 tells them to retry something that will never
 * work. It also filled the log with "unhandled error" for input that was
 * handled perfectly well, which is how a real fault ends up buried.
 *
 * Nothing about the error itself is returned. The message can name a table, a
 * column or a file path, and a 500 body is the wrong place for any of that.
 */
app.use(
  (
    err: Error & { status?: number; statusCode?: number; type?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    // body-parser marks its own failures and sets a status; anything else that
    // arrives here is ours.
    const parseFailed =
      err instanceof SyntaxError ||
      err.type === "entity.parse.failed" ||
      err.type === "entity.verify.failed";
    const tooLarge = err.type === "entity.too.large";

    if (parseFailed || tooLarge) {
      const status = tooLarge ? 413 : 400;
      // Logged quietly and without a stack: this is traffic, not a fault.
      console.warn(`[http] rejected a malformed request body (${status})`);
      if (res.headersSent) return;
      res.status(status).json({
        error: tooLarge ? "That was too large." : "That request body was not valid JSON.",
      });
      return;
    }

    console.error("[http] unhandled error:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  },
);

setupSocket(server);

async function start(): Promise<void> {
  // Shared state first: if Redis is configured but down, refuse to start
  // rather than quietly becoming an isolated island in the cluster.
  const store = await initStores();
  console.log(`  🗄️  State store: ${store.kind}`);

  warnIfNoTurn();

  // Load the inference model before accepting traffic, so the first user does
  // not eat a multi-second cold start.
  try {
    const provider = await createGenderProvider();
    genderService.setProvider(provider);
    console.log(`  🧠 Gender provider: ${provider.name} (ready=${provider.isReady()})`);
  } catch (err) {
    console.error("  ⚠️  Gender provider failed to initialise:", err);
  }

  /*
   * A process that cannot listen must not linger.
   *
   * listen() reports failure by emitting "error", which with no handler
   * becomes an uncaught exception — and the guard below deliberately keeps the
   * process alive through those. For a runtime error that is right. For a
   * failed bind it is actively harmful: setupSocket has already connected to
   * Redis and started the sweep timers, so the instance goes on matching and
   * evicting entries in the shared queue while holding no sockets of its own.
   *
   * Six of them accumulated that way during development. Users were being
   * paired by an instance that could not deliver to them, and simply vanished
   * from the queue — which reads exactly like a matchmaking bug, several
   * layers away from the port conflict that caused it.
   */
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[server] port ${env.PORT} is already in use. Another instance is running; ` +
          `stop it first. Exiting rather than running alongside it.`,
      );
    } else {
      console.error("[server] could not listen:", err.stack ?? err.message);
    }
    process.exit(1);
  });

  server.listen(env.PORT, () => {
    console.log(`
  ✨ Omextv API Server
  🚀 http://localhost:${env.PORT}
  🌍 ${env.NODE_ENV}
  `);
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, shutting down...`);

  const force = setTimeout(() => {
    console.error("[server] forced exit after 10s");
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    await shutdownSocket();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await genderService.dispose();
    await closeStores();
    await prisma.$disconnect();
    console.log("[server] clean shutdown");
    process.exit(0);
  } catch (err) {
    console.error("[server] shutdown error:", err);
    process.exit(1);
  }
}

/*
 * Stay up when something unexpected throws.
 *
 * Node exits on an unhandled rejection by default, which for this process
 * means every call in progress drops for everyone. That is almost never the
 * right trade: one broken request is survivable, a dead server is not.
 * Stopping Redis used to take the whole API down this way, health endpoint
 * included, so there was nothing left to report the problem.
 *
 * These are a backstop, not a licence to ignore errors — anything logged here
 * is a missing `.catch` somewhere and should be fixed at the source. An
 * uncaught *exception* leaves less certainty about internal state, so it is
 * logged loudly but still not fatal; the health check reports the store being
 * unreachable, which is what a supervisor should restart on.
 *
 * Startup is the exception, and it is handled where it happens: a process that
 * failed to bind its port has nothing to survive for, and surviving is worse
 * than exiting because it keeps mutating shared state. See server.on("error").
 */
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error("[unhandledRejection]", message);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.stack ?? err.message);
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

if (require.main === module) {
  void start();
}

export { app, server, start };
export default app;
