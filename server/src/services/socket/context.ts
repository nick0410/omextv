import { Server, Socket } from "socket.io";

import { env } from "../../config/env";
import { RateLimiter } from "../../utils/rateLimiter";
import { Gender, InferredGender } from "../../types";

/**
 * The state every part of the socket layer shares.
 *
 * It lives in one place so the rest can be split by what it does rather than
 * by what it happens to touch. The alternative — each file keeping its own
 * handle on the server, or importing it from whichever sibling declared it —
 * is what turns a set of modules back into one module with extra steps.
 */

/** What the socket layer needs to know about the person on the other end. */
export interface SocketUser {
  id: string;
  username: string;
  gender: Gender;
  verifiedGender: InferredGender | null;
  genderConfidence: number | null;
  genderVerifiedAt: Date | null;
  isPremium: boolean;
  country: string | null;
  city: string | null;
}

export type AuthedSocket = Socket & { user: SocketUser };

/** Channel used to hand an event to whichever instance owns the socket. */
export const BUS_CHANNEL = "omextv:emit";

/** Per-user limiters. Keyed by userId so a reconnect cannot reset the budget. */
export const queueLimiter = new RateLimiter(env.QUEUE_JOINS_PER_MIN, env.QUEUE_JOINS_PER_MIN / 60);
export const messageLimiter = new RateLimiter(env.MESSAGES_PER_MIN, env.MESSAGES_PER_MIN / 60);
export const signalLimiter = new RateLimiter(env.SIGNALS_PER_MIN, env.SIGNALS_PER_MIN / 60);

/** Users whose socket dropped while paired, awaiting a reconnect. */
export const reconnectTimers = new Map<string, NodeJS.Timeout>();

/**
 * Calls that will be charged for once they have lasted long enough.
 *
 * Keyed by room so a call that ends early can cancel its own charge. Losing
 * these on a restart costs a charge, which is the right direction to fail:
 * nobody is billed for a call the server has forgotten.
 */
export const callChargeTimers = new Map<string, NodeJS.Timeout>();

/**
 * Calls that will be charged for if they ever connect.
 *
 * Who owes is known when the match is made, but whether there is anything to
 * charge for is not known until the two ends actually reach each other. A
 * charge scheduled at match time bills for a call that may never happen —
 * which, without a relay configured, is a large share of them.
 *
 * Kept keyed by room and consumed once, so a second "connected" from a
 * reconnect cannot start a second clock against the same call.
 */
export const pendingCallCharges = new Map<string, PendingCharge>();

export interface PendingCharge {
  /** The people who owe for this call, if it connects. */
  owing: { userId: string }[];
  /** Set once the first end reports the call up, so it cannot restart. */
  started: boolean;
}

/**
 * When each user's lastSeenAt was last written.
 *
 * Throttled because reconnects are not rare — a dropped tunnel reconnects
 * every socket at once, and none of those are worth a row update. Held in
 * memory on purpose: losing it on restart costs one redundant write per user.
 */
export const lastSeenWrites = new Map<string, number>();
export const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

/**
 * The running server.
 *
 * Behind functions rather than exported directly: an exported `let` is copied
 * at import time by every consumer, so they would all keep the `null` it held
 * before setup ran.
 */
let server: Server | null = null;

export function setIo(next: Server | null): void {
  server = next;
}

export function getIo(): Server | null {
  return server;
}
