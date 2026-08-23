import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
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
app.use(express.json({ limit: "6mb" }));
app.use(cookieParser());

app.get("/health", async (_req, res) => {
  const store = stores();
  const storeOk = await store.ping();
  // A dead Redis means this node cannot see the shared queue at all, so it
  // must fail its health check and be pulled from the load balancer.
  res.status(storeOk ? 200 : 503).json({
    status: storeOk ? "ok" : "degraded",
    name: "Omextv API",
    version: "2.1.0",
    store: store.kind,
    storeOk,
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

// Express error handler must come last and take four args to be recognised.
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
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

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

if (require.main === module) {
  void start();
}

export { app, server, start };
export default app;
