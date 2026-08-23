import rateLimit, { type Options } from "express-rate-limit";
import type { Request, Response } from "express";
import { env } from "../config/env";

/**
 * HTTP rate limits.
 *
 * The socket layer has had token buckets from the start, but the REST surface
 * had none — so password guessing and bulk account creation were both
 * unthrottled, which is the cheapest attack there is against a public sign-in
 * form.
 *
 * Keyed by IP. `trust proxy` is set to 1 in index.ts because the API sits
 * behind a tunnel, so `req.ip` is the client rather than the proxy.
 */

/**
 * Requests originating on this machine are not rate limited.
 *
 * Safe because the API sits behind a tunnel that forwards the real client
 * address — verified: a request through the tunnel arrives with the caller's
 * public IP, not the tunnel's. So loopback only ever matches something running
 * here: the deploy scripts, the health probe, the smoke and probe suites.
 * Throttling those means the tooling that proves the server works is the first
 * thing the server blocks.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const isLocal = (req: Request): boolean => LOOPBACK.has(req.ip ?? "");

const shared: Partial<Options> = {
  skip: isLocal,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many requests. Wait a moment and try again.",
    });
  },
};

/**
 * Sign-in attempts.
 *
 * `skipSuccessfulRequests` means the counter only advances on a failure, so
 * somebody signing in normally on a shared connection — a hostel, an office,
 * mobile carrier NAT — is never locked out by their neighbours' activity.
 */
export const loginLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60_000,
  limit: env.LOGIN_ATTEMPTS_PER_15MIN,
  skipSuccessfulRequests: true,
  skip: isLocal,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many sign-in attempts. Try again in a few minutes.",
    });
  },
});

export const registerLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60_000,
  limit: env.SIGNUPS_PER_HOUR,
  skip: isLocal,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many accounts created from this network. Try again later.",
    });
  },
});

/**
 * A backstop for everything else.
 *
 * Set high enough that normal use never reaches it — the client polls online
 * counts every 15 seconds and the diagnostics page makes a burst of calls —
 * while still bounding what a single address can do.
 */
export const apiLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.API_REQUESTS_PER_MIN,
  // Health checks are how the deploy scripts and the tunnel verify the API is
  // alive; throttling them turns a busy minute into a false outage.
  skip: (req: Request) => isLocal(req) || req.path === "/health",
});
