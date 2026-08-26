import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { asyncRoute } from "../utils/asyncRoute";

/**
 * What happens when an async handler's promise rejects.
 *
 * Express 4 calls a handler and ignores its return value, so a rejection
 * reaches nothing: the error handler never runs, no response is written, and
 * the request hangs until the client gives up. The only trace is an
 * unhandledRejection logged long after the user has left — which is why the
 * coin routes could ship with ten async handlers and no error handling without
 * a single test noticing.
 *
 * The first case here is the proof that the problem is real, so the wrapper
 * cannot quietly be removed as unnecessary later.
 */
describe("async handler failures", () => {
  /** An app shaped like the real one: routes, then a four-arg error handler. */
  function appWith(handler: express.RequestHandler) {
    const app = express();
    app.get("/boom", handler);
    app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "Internal server error" });
    });
    return app;
  }

  it("an unwrapped handler never answers at all", async () => {
    // Not a 500 — nothing. The request simply stays open, which is why a short
    // deadline is the only way to observe it.
    //
    // The rejection escapes to the process, exactly as it would in production.
    // Caught here so this demonstration does not fail the run it belongs to;
    // in the real server it surfaces as an unhandledRejection in the log, long
    // after the user gave up.
    const escaped: unknown[] = [];
    const capture = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", capture);

    try {
      const bare: express.RequestHandler = async () => {
        throw new Error("database is down");
      };

      const attempt = request(appWith(bare)).get("/boom").timeout({ deadline: 300 });
      await expect(attempt).rejects.toThrow();

      // Give the rejection a turn to reach the process.
      await new Promise((r) => setTimeout(r, 50));
      expect(escaped).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", capture);
    }
  });

  it("a wrapped handler fails as a 500", async () => {
    const wrapped = asyncRoute(async () => {
      throw new Error("database is down");
    });

    const res = await request(appWith(wrapped)).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });

  it("passes a rejection on rather than swallowing it", async () => {
    // Hiding the cause would trade a hang for a silent wrong answer.
    const seen: Error[] = [];
    const app = express();
    app.get(
      "/boom",
      asyncRoute(async () => {
        throw new Error("specific cause");
      }),
    );
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      seen.push(err);
      res.status(500).end();
    });

    await request(app).get("/boom");
    expect(seen.map((e) => e.message)).toEqual(["specific cause"]);
  });

  it("leaves a handler that succeeds completely alone", async () => {
    const app = express();
    app.get(
      "/fine",
      asyncRoute(async (_req, res) => {
        res.json({ ok: true });
      }),
    );

    const res = await request(app).get("/fine");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("works for middleware that calls next", async () => {
    // requireAdmin is wrapped the same way, and it lets the request through
    // rather than answering it.
    const app = express();
    const gate = asyncRoute(async (_req, _res, next) => {
      await Promise.resolve();
      next();
    });
    app.get("/through", gate, (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/through");
    expect(res.body).toEqual({ ok: true });
  });
});

describe("the coin routes are all wrapped", () => {
  it("answers rather than hanging when the service fails", async () => {
    // The regression this exists to catch: every handler in routes/coins.ts
    // awaits, and none of them had a try/catch after the refactor.
    vi.resetModules();
    vi.doMock("../services/coins", () => ({
      coins: () => ({
        walletFor: () => Promise.reject(new Error("database is down")),
      }),
    }));

    /*
     * A real account, not just a well-formed token.
     *
     * `authenticate` runs first and now asks the database whether this account
     * is shut out, which a token naming an account that does not exist is --
     * a deleted account's token has to stop working. So this case has to get
     * past a gate that has become stricter than it was, and it does that by
     * being a genuine user rather than by the gate being loosened.
     */
    vi.doMock("../services/ban", () => ({
      isShutOut: () => Promise.resolve(false),
      banStatus: () => "none",
      clearExpiredBan: () => Promise.resolve(),
    }));
    vi.resetModules();

    const { default: routes } = await import("../routes/coins");
    const app2 = express();
    app2.use(express.json());
    app2.use("/api/coins", routes);
    app2.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "Internal server error" });
    });

    const token = jwt.sign({ userId: "u1", email: "u1@test.local" }, env.JWT_SECRET, {
      expiresIn: "1h",
    });
    const res = await request(app2)
      .get("/api/coins/me")
      .set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(500);

    vi.doUnmock("../services/ban");
    vi.doUnmock("../services/coins");
    vi.resetModules();
  });
});
