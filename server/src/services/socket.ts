import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

import { env } from "../config/env";
import { prisma } from "../config/database";
import * as matcher from "./matchmaking/matcher";
import { stores } from "./store";
import {
  persistSessionStart,
  persistSessionEnd,
  loadBlockedIds,
  loadRecentPartners,
} from "./pairing";
import type { PairRecord } from "./store/types";
import { genderService } from "./gender/service";
import { RateLimiter } from "../utils/rateLimiter";
import { detach } from "../utils/detach";
import { parseMatchFilters, genderVerifySchema } from "../utils/validation";
import { applyEntitlement } from "./coins/entitlement";
import {
  JWTPayload,
  QueueEntry,
  MatchResult,
  Gender,
  InferredGender,
  EndReason,
} from "../types";

interface SocketUser {
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

type AuthedSocket = Socket & { user: SocketUser };

/** Per-user limiters. Keyed by userId so a reconnect cannot reset the budget. */
const queueLimiter = new RateLimiter(env.QUEUE_JOINS_PER_MIN, env.QUEUE_JOINS_PER_MIN / 60);
const messageLimiter = new RateLimiter(env.MESSAGES_PER_MIN, env.MESSAGES_PER_MIN / 60);
const signalLimiter = new RateLimiter(env.SIGNALS_PER_MIN, env.SIGNALS_PER_MIN / 60);

/** Users whose socket dropped while paired, awaiting a reconnect. */
const reconnectTimers = new Map<string, NodeJS.Timeout>();

/** Channel used to hand an event to whichever instance owns the socket. */
const BUS_CHANNEL = "omextv:emit";

let io: Server | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let janitorTimer: NodeJS.Timeout | null = null;

export async function getOnlineCount(): Promise<number> {
  return stores().presence.onlineCount();
}

export async function getStats() {
  const store = stores();
  const [online, activeChats, queue] = await Promise.all([
    store.presence.onlineCount(),
    store.pairing.activeCount(),
    matcher.queueStats(),
  ]);

  return {
    online,
    activeChats,
    ...queue,
    store: store.kind,
    instance: env.INSTANCE_ID,
    genderProvider: genderService.getProviderName(),
    genderReady: genderService.isReady(),
  };
}

export function setupSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: env.IS_PROD ? [env.CLIENT_URL, ...env.ALLOWED_ORIGINS] : true,
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60_000,
    pingInterval: 25_000,
    maxHttpBufferSize: 5e6, // gender frames travel over this channel
  });

  io.use(authMiddleware);

  io.on("connection", (socket) => {
    detach(onConnection(socket as AuthedSocket), "socket:connection");
  });

  detach(subscribeToBus(), "socket:bus");
  startTimers();
  return io;
}

/**
 * Deliver events addressed to sockets on this instance.
 *
 * Each node subscribes once; a message naming a user it does not hold is
 * simply ignored, so exactly one node delivers.
 */
async function subscribeToBus(): Promise<void> {
  const store = stores();
  if (store.kind !== "redis") return;

  await store.bus.subscribe(BUS_CHANNEL, (message) => {
    const { userId, event, payload } = (message ?? {}) as {
      userId?: string;
      event?: string;
      payload?: unknown;
    };
    if (typeof userId !== "string" || typeof event !== "string") return;

    detach((async () => {
      const socketId = await stores().presence.socketOf(userId);
      if (!socketId) return;
      const socket = io?.sockets.sockets.get(socketId);
      socket?.emit(event, payload);
    })(), "socket:background");
  });
}

// --- Auth ------------------------------------------------------------------

async function authMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string" || token.length === 0) {
    return next(new Error("Authentication required"));
  }

  let decoded: JWTPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
  } catch {
    return next(new Error("Invalid or expired token"));
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        username: true,
        gender: true,
        verifiedGender: true,
        genderConfidence: true,
        genderVerifiedAt: true,
        isPremium: true,
        premiumExpiry: true,
        country: true,
        city: true,
        isBanned: true,
        bannedUntil: true,
      },
    });

    if (!user) return next(new Error("User not found"));

    // A ban that has expired should not keep anyone out.
    const now = Date.now();
    if (user.isBanned) {
      const stillBanned = !user.bannedUntil || user.bannedUntil.getTime() > now;
      if (stillBanned) return next(new Error("Account suspended"));
      await prisma.user.update({
        where: { id: user.id },
        data: { isBanned: false, bannedUntil: null },
      });
    }

    // Likewise, premium that lapsed must not keep granting priority.
    const premiumActive =
      user.isPremium && (!user.premiumExpiry || user.premiumExpiry.getTime() > now);

    (socket as AuthedSocket).user = {
      id: user.id,
      username: user.username,
      gender: user.gender as Gender,
      verifiedGender: (user.verifiedGender as InferredGender | null) ?? null,
      genderConfidence: user.genderConfidence,
      genderVerifiedAt: user.genderVerifiedAt,
      isPremium: premiumActive,
      country: user.country,
      city: user.city,
    };
    next();
  } catch (err) {
    console.error("[socket] auth lookup failed:", err);
    next(new Error("Authentication failed"));
  }
}

// --- Connection lifecycle --------------------------------------------------

async function onConnection(socket: AuthedSocket): Promise<void> {
  const user = socket.user;

  const store = stores();

  /*
   * Set presence up, but attach the handlers before waiting for it.
   *
   * A client's "connect" fires the moment the transport is up, and a keen one
   * emits join-queue immediately. That emit used to land while this function
   * was still awaiting Redis, with the listeners not attached until the very
   * end — and socket.io drops an event nobody is listening for. No error, no
   * queue entry, no match: the user sat on a "searching" screen that was
   * searching for nothing. Rare enough to look like bad luck, and it showed up
   * as roughly one lost user per six simultaneous joins.
   *
   * Listening first fixes that, but on its own it would let a handler run
   * before presence exists — and the sweep evicts anyone it cannot see as
   * online, which loses the user just as silently. So the handlers wait on
   * this promise instead: attached immediately, held until it is safe.
   */
  const ready = (async () => {
    const evictedSocketId = await store.presence.register(user.id, socket.id, env.INSTANCE_ID);
    if (evictedSocketId) {
      // Same account opened elsewhere. Close the old socket, but leave any
      // in-flight pair alone — the new socket adopts it below.
      const old = io?.sockets.sockets.get(evictedSocketId);
      old?.emit("session-replaced", { reason: "signed_in_elsewhere" });
      old?.disconnect(true);
    }
  })();

  registerHandlers(socket, ready);
  await ready;

  // Cancel a pending reconnect teardown — they made it back in time.
  const pendingTimer = reconnectTimers.get(user.id);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    reconnectTimers.delete(user.id);
  }

  socket.emit("connected", {
    userId: user.id,
    username: user.username,
    genderVerified: isGenderVerified(user),
    onlineCount: await store.presence.onlineCount(),
  });

  // Restore an interrupted chat.
  const existingPair = await store.pairing.pairOf(user.id);
  if (existingPair) {
    socket.join(existingPair.roomId);
    const partnerId =
      existingPair.userAId === user.id ? existingPair.userBId : existingPair.userAId;
    socket.emit("chat-resumed", {
      roomId: existingPair.roomId,
      partnerId,
      startedAt: existingPair.startedAt,
    });
    await emitToUser(partnerId, "partner-reconnected", { roomId: existingPair.roomId });
  }
}

function registerHandlers(socket: AuthedSocket, ready: Promise<void>): void {
  const user = socket.user;

  /*
   * Attached now, run once setup has finished.
   *
   * Chaining off `ready` rather than awaiting it here is the point: the
   * listener exists from this moment, so nothing the client sends is dropped
   * for want of one, and the work still happens in arrival order because each
   * chain starts from the same settled promise.
   */
  const gate = (context: string, run: () => void | Promise<void>) =>
    detach(ready.then(run), context);

  socket.on("join-queue", (payload) => gate("socket:join-queue", () => onJoinQueue(socket, payload)));
  socket.on("leave-queue", () => gate("socket:leave-queue", () => onLeaveQueue(socket)));

  socket.on("offer", (payload) => gate("socket:offer", () => onSignal(socket, "offer", payload)));
  socket.on("answer", (payload) => gate("socket:answer", () => onSignal(socket, "answer", payload)));
  socket.on("ice-candidate", (payload) =>
    gate("socket:ice-candidate", () => onSignal(socket, "ice-candidate", payload)));

  socket.on("chat-message", (payload) => gate("socket:chat-message", () => onChatMessage(socket, payload)));
  socket.on("typing", (payload) => gate("socket:typing", () => onTyping(socket, payload)));

  socket.on("skip", (payload) => gate("socket:skip", () => onLeaveChat(socket, payload, "skip")));
  socket.on("end-chat", (payload) => gate("socket:end-chat", () => onLeaveChat(socket, payload, "end")));

  socket.on("verify-gender", (payload, ack) =>
    gate("socket:verify-gender", () => onVerifyGender(socket, payload, ack)));
  socket.on("queue-status", () => {
    gate("socket:background", async () => {
      const store = stores();
      socket.emit("queue-status", {
        position: await matcher.queuePosition(user.id),
        size: await matcher.queueSize(),
        online: await store.presence.onlineCount(),
      });
    });
  });

  socket.on("disconnect", (reason) => gate("socket:disconnect", () => onDisconnect(socket, reason)));
}

// --- Queue -----------------------------------------------------------------

async function onJoinQueue(socket: AuthedSocket, payload: unknown): Promise<void> {
  const user = socket.user;

  const limit = queueLimiter.consume(user.id);
  if (!limit.allowed) {
    socket.emit("queue-error", {
      code: "rate_limited",
      message: "Too many queue requests. Slow down.",
      retryAfterMs: limit.retryAfterMs,
    });
    return;
  }

  // Cannot queue while already talking to someone.
  if (await stores().pairing.isPaired(user.id)) {
    socket.emit("queue-error", {
      code: "already_in_chat",
      message: "You are already in a chat. Skip or end it first.",
    });
    return;
  }

  if (env.REQUIRE_GENDER_VERIFICATION && !isGenderVerified(user)) {
    socket.emit("queue-error", {
      code: "verification_required",
      message: "Camera verification is required before matching.",
    });
    return;
  }

  /*
   * Free accounts match anyone.
   *
   * Choosing a gender or a country is what premium sells, so the limit is
   * applied here, where the request actually takes effect, rather than in the
   * UI. The controls are disabled there too, but that is a courtesy: this
   * payload arrives over a socket and can be sent by hand.
   *
   * Clamped rather than refused — see applyEntitlement. The client is told
   * what was dropped so it can say so plainly instead of leaving someone to
   * wonder why they are meeting people they filtered out.
   */
  const requested = parseMatchFilters(payload);
  const { filters, dropped } = applyEntitlement(requested, user.isPremium);
  if (dropped.length > 0) {
    socket.emit("filters-restricted", {
      dropped,
      message:
        "Choosing who you meet is a premium feature. Searching everyone for now.",
    });
  }

  try {
    const entry = await buildQueueEntry(socket, filters);
    const match = await matcher.joinQueue(entry);

    if (match) {
      await establishMatch(match);
    } else {
      socket.emit("queue-joined", {
        position: await matcher.queuePosition(user.id),
        size: await matcher.queueSize(),
        filters,
      });
    }
  } catch (err) {
    console.error("[socket] join-queue failed:", err);
    await matcher.leaveQueue(user.id);
    socket.emit("queue-error", { code: "internal", message: "Failed to join the queue." });
  }
}

async function buildQueueEntry(socket: AuthedSocket, filters: QueueEntry["filters"]): Promise<QueueEntry> {
  const user = socket.user;

  // Loaded before the (synchronous) matching step, so the matcher never awaits.
  const [blockedIds, recentPartners] = await Promise.all([
    loadBlockedIds(user.id),
    loadRecentPartners(user.id, 30 * 60_000),
  ]);

  const { effectiveGender, verified } = genderService.resolveEffectiveGender(user);

  return {
    userId: user.id,
    socketId: socket.id,
    username: user.username,
    gender: user.gender,
    verifiedGender: user.verifiedGender,
    effectiveGender,
    genderIsVerified: verified,
    country: user.country,
    city: user.city,
    isPremium: user.isPremium,
    filters,
    blockedIds,
    recentPartners,
    joinedAt: Date.now(),
    relaxStage: 0,
  };
}

async function onLeaveQueue(socket: AuthedSocket): Promise<void> {
  const removed = await matcher.leaveQueue(socket.user.id);
  socket.emit("queue-left", { wasQueued: removed !== null });
}

/**
 * Turn a match into a live room.
 *
 * Both sockets are re-resolved from the presence registry rather than trusted
 * from the queue entry: a user can disconnect between joining the queue and
 * being matched, and emitting into a dead socket would strand the other side
 * in a room with a ghost. If one side is gone, the survivor goes back to the
 * front of the queue instead of being told about a partner who is not there.
 */
async function establishMatch(match: MatchResult, depth = 0): Promise<void> {
  if (!io) return;

  const aSocket = await liveSocketFor(match.a.userId);
  const bSocket = await liveSocketFor(match.b.userId);

  if (!aSocket || !bSocket) {
    const survivor = aSocket ? match.a : bSocket ? match.b : null;
    const lost = aSocket ? match.b : match.a;
    await matcher.leaveQueue(lost.userId);

    if (survivor) {
      // Preserve the original joinedAt so they keep their place in line.
      const retry = await matcher.joinQueue(survivor);

      // Re-queuing can itself produce a match. Dropping it here would leave
      // both of those users dequeued and never told, waiting forever.
      // `depth` bounds the chain in case a whole run of queued sockets has
      // died, so one bad batch cannot recurse without end.
      if (retry) {
        if (depth < 10) {
          await establishMatch(retry, depth + 1);
        } else {
          console.error("[socket] establishMatch recursion cap hit; re-queueing both");
          await matcher.joinQueue(retry.a);
          await matcher.joinQueue(retry.b);
        }
        return;
      }

      (await liveSocketFor(survivor.userId))?.emit("queue-requeued", {
        reason: "partner_unavailable",
        position: await matcher.queuePosition(survivor.userId),
      });
    }
    return;
  }

  const now = Date.now();
  const pair: PairRecord = {
    roomId: match.roomId,
    userAId: match.a.userId,
    userBId: match.b.userId,
    startedAt: now,
    dbId: null,
    messageCount: 0,
    lastActivityAt: now,
  };

  // Write the ChatSession row *before* putting the pair in the store, so the
  // stored record already carries its dbId. Doing it the other way round left
  // the id only on this local object — the copy the teardown path reads back
  // still had null, so the session was never closed out in the database.
  await persistSessionStart(pair, match.matchedOn);
  await stores().pairing.create(pair);

  aSocket.join(match.roomId);
  bSocket.join(match.roomId);

  // Exactly one side creates the WebRTC offer, else both would and glare.
  aSocket.emit("match-found", {
    roomId: match.roomId,
    isInitiator: true,
    partner: publicProfile(match.b),
    waitedMs: match.matchedOn.aWaitedMs,
    relaxStage: match.stage,
  });

  bSocket.emit("match-found", {
    roomId: match.roomId,
    isInitiator: false,
    partner: publicProfile(match.a),
    waitedMs: match.matchedOn.bWaitedMs,
    relaxStage: match.stage,
  });
}

/** What the other person is allowed to learn about you. Never the email. */
function publicProfile(entry: QueueEntry) {
  return {
    userId: entry.userId,
    username: entry.username,
    gender: entry.effectiveGender,
    genderVerified: entry.genderIsVerified,
    country: entry.country,
    city: entry.city,
    isPremium: entry.isPremium,
  };
}

// --- WebRTC signalling -----------------------------------------------------

/**
 * Relay an SDP/ICE payload to the other member of the room.
 *
 * Membership is checked against our own pairing registry rather than against
 * socket.io rooms: a client could previously emit into any roomId it guessed
 * and inject signalling into strangers' calls.
 */
function onSignal(socket: AuthedSocket, event: string, payload: unknown): void {
  const user = socket.user;

  const limit = signalLimiter.consume(user.id);
  if (!limit.allowed) return;

  if (typeof payload !== "object" || payload === null) return;
  const { roomId } = payload as { roomId?: unknown };
  if (typeof roomId !== "string") return;

  detach((async () => {
    const store = stores();
    if (!(await store.pairing.isMember(user.id, roomId))) {
      socket.emit("signal-rejected", { code: "not_a_member", roomId });
      return;
    }
    await store.pairing.touch(roomId, Date.now());
    socket.to(roomId).emit(event, { ...(payload as object), from: user.id });
  })(), "socket:background");
}

// --- Text chat -------------------------------------------------------------

function onChatMessage(socket: AuthedSocket, payload: unknown): void {
  const user = socket.user;

  if (typeof payload !== "object" || payload === null) return;
  const { roomId, text } = payload as { roomId?: unknown; text?: unknown };

  if (typeof roomId !== "string" || typeof text !== "string") return;

  const trimmed = text.trim();
  if (trimmed.length === 0) return;

  const limit = messageLimiter.consume(user.id);
  if (!limit.allowed) {
    socket.emit("message-rejected", {
      code: "rate_limited",
      retryAfterMs: limit.retryAfterMs,
    });
    return;
  }

  const message = {
    id: randomUUID(),
    senderId: user.id,
    senderName: user.username,
    text: trimmed.slice(0, env.MAX_MESSAGE_LENGTH),
    timestamp: Date.now(),
  };

  detach((async () => {
    const store = stores();
    if (!(await store.pairing.isMember(user.id, roomId))) {
      socket.emit("message-rejected", { code: "not_a_member" });
      return;
    }
    await store.pairing.noteMessage(roomId, Date.now());
    io?.to(roomId).emit("chat-message", message);
  })(), "socket:background");
}

function onTyping(socket: AuthedSocket, payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const { roomId, isTyping } = payload as { roomId?: unknown; isTyping?: unknown };
  if (typeof roomId !== "string") return;
  detach((async () => {
    if (!(await stores().pairing.isMember(socket.user.id, roomId))) return;
    socket.to(roomId).emit("typing", { userId: socket.user.id, isTyping: isTyping === true });
  })(), "socket:background");
}

// --- Leaving a chat --------------------------------------------------------

async function onLeaveChat(
  socket: AuthedSocket,
  payload: unknown,
  reason: EndReason,
): Promise<void> {
  const user = socket.user;
  const pair = await stores().pairing.pairOf(user.id);
  if (!pair) {
    socket.emit("chat-ended", { reason, roomId: null });
    return;
  }

  // Ignore a roomId that is not actually theirs.
  if (typeof payload === "object" && payload !== null) {
    const { roomId } = payload as { roomId?: unknown };
    if (typeof roomId === "string" && roomId !== pair.roomId) return;
  }

  const partnerId = pair.userAId === user.id ? pair.userBId : pair.userAId;
  await teardownPair(pair.roomId, reason, user.id);

  socket.emit("chat-ended", { reason, roomId: pair.roomId });
  await emitToUser(partnerId, "partner-left", { reason, roomId: pair.roomId });
}

/** End a pair: leave the room, persist, notify nobody (callers do that). */
async function teardownPair(
  roomId: string,
  reason: EndReason,
  endedById: string | null,
): Promise<void> {
  const pair = await stores().pairing.end(roomId);
  if (!pair) return;

  for (const userId of [pair.userAId, pair.userBId]) {
    (await liveSocketFor(userId))?.leave(roomId);
  }

  await persistSessionEnd(pair, reason, endedById);
}

// --- Gender verification ---------------------------------------------------

async function onVerifyGender(
  socket: AuthedSocket,
  payload: unknown,
  ack?: (res: unknown) => void,
): Promise<void> {
  const user = socket.user;
  const respond = (res: unknown) => {
    if (typeof ack === "function") ack(res);
    socket.emit("gender-verified", res);
  };

  const parsed = genderVerifySchema.safeParse(payload);
  if (!parsed.success) {
    respond({ ok: false, outcome: "invalid_image" });
    return;
  }

  try {
    const result = await genderService.verify(user.id, parsed.data.frames);

    if (result.outcome === "accepted" && result.gender) {
      // Keep the in-memory socket user in step so the next join-queue uses it
      // without a database round-trip.
      user.verifiedGender = result.gender;
      user.genderConfidence = result.confidence;
      user.genderVerifiedAt = new Date();
    }

    respond({
      ok: result.outcome === "accepted",
      outcome: result.outcome,
      gender: result.gender,
      confidence: result.confidence,
      mismatch: result.mismatch,
      retryAfterMs: result.retryAfterMs,
      framesUsed: result.framesUsed,
      agreement: result.agreement,
    });
  } catch (err) {
    console.error("[socket] gender verification failed:", err);
    respond({ ok: false, outcome: "provider_unavailable" });
  }
}

function isGenderVerified(user: SocketUser): boolean {
  return genderService.resolveEffectiveGender(user).verified;
}

// --- Disconnect ------------------------------------------------------------

async function onDisconnect(socket: AuthedSocket, reason: string): Promise<void> {
  const user = socket.user;

  // A socket that was already replaced must not tear down the newer session.
  const store = stores();
  const wasCurrent = await store.presence.isCurrentSocket(user.id, socket.id);
  await store.presence.unregister(socket.id);

  if (!wasCurrent) return;

  await matcher.leaveQueue(user.id);

  const pair = await store.pairing.pairOf(user.id);
  if (!pair) return;

  const partnerId = pair.userAId === user.id ? pair.userBId : pair.userAId;

  // Hold the room open briefly: a refresh or a flaky network should not end
  // the conversation outright.
  if (env.RECONNECT_GRACE_MS > 0) {
    await emitToUser(partnerId, "partner-connection-lost", {
      roomId: pair.roomId,
      graceMs: env.RECONNECT_GRACE_MS,
    });

    const timer = setTimeout(() => {
      detach((async () => {
        reconnectTimers.delete(user.id);
        if (await store.presence.isOnline(user.id)) return; // came back
        const stillPaired = await store.pairing.pairOf(user.id);
        if (!stillPaired || stillPaired.roomId !== pair.roomId) return;

        await teardownPair(pair.roomId, "disconnect", user.id);
        await emitToUser(partnerId, "partner-left", { reason: "disconnect", roomId: pair.roomId });
      })(), "socket:background");
    }, env.RECONNECT_GRACE_MS);

    reconnectTimers.set(user.id, timer);
    return;
  }

  await teardownPair(pair.roomId, "disconnect", user.id);
  await emitToUser(partnerId, "partner-left", { reason: "disconnect", roomId: pair.roomId });
  void reason;
}

// --- Helpers ---------------------------------------------------------------

async function liveSocketFor(userId: string): Promise<Socket | null> {
  const socketId = await stores().presence.socketOf(userId);
  if (!socketId || !io) return null;
  return io.sockets.sockets.get(socketId) ?? null;
}

/**
 * Deliver an event to a user wherever they are.
 *
 * When the socket lives on another instance the local lookup misses, so the
 * event is published on the bus for the owning node to deliver. Without that
 * hop, a cross-instance pair could never notify each other.
 */
async function emitToUser(userId: string, event: string, payload: unknown): Promise<boolean> {
  const socket = await liveSocketFor(userId);
  if (socket) {
    socket.emit(event, payload);
    return true;
  }

  const store = stores();
  if (store.kind === "redis" && (await store.presence.isOnline(userId))) {
    await store.bus.publish(BUS_CHANNEL, { userId, event, payload });
    return true;
  }
  return false;
}

// --- Background timers -----------------------------------------------------

function startTimers(): void {
  // Re-evaluate waiting users so relaxation stages actually take effect.
  sweepTimer = setInterval(() => {
    detach(
      (async () => {
        const matches = await matcher.sweep();
        for (const match of matches) await establishMatch(match);
      })(),
      "socket:sweep",
    );
  }, env.MATCH_SWEEP_INTERVAL_MS);

  janitorTimer = setInterval(() => {
    try {
      queueLimiter.sweep();
      messageLimiter.sweep();
      signalLimiter.sweep();
      detach(stores().pairing.sweepRecent(60 * 60_000, Date.now()), "socket:sweep-recent");

      if (env.CHAT_IDLE_TIMEOUT_MS > 0) {
        detach((async () => {
          const idle = await stores().pairing.findIdle(env.CHAT_IDLE_TIMEOUT_MS, Date.now());
          for (const pair of idle) {
            await teardownPair(pair.roomId, "timeout", null);
            await emitToUser(pair.userAId, "partner-left", { reason: "timeout", roomId: pair.roomId });
            await emitToUser(pair.userBId, "partner-left", { reason: "timeout", roomId: pair.roomId });
          }
        })(), "socket:background");
      }
    } catch (err) {
      console.error("[socket] janitor failed:", err);
    }
  }, 60_000);

  sweepTimer.unref?.();
  janitorTimer.unref?.();
}

/** Close everything cleanly so a redeploy does not leave dangling chats. */
export async function shutdownSocket(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer);
  if (janitorTimer) clearInterval(janitorTimer);
  sweepTimer = null;
  janitorTimer = null;

  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();

  const pairs = await stores().pairing.allPairs();
  await Promise.allSettled(
    pairs.map((pair) => persistSessionEnd(pair, "server_shutdown", null)),
  );

  io?.emit("server-shutdown", {});
  await new Promise<void>((resolve) => {
    if (!io) return resolve();
    io.close(() => resolve());
  });

  const store = stores();
  await store.queue.clear();
  await store.pairing.clear();
  await store.presence.clear();
  io = null;
}
