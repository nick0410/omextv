import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";

import { env } from "../../config/env";
import * as matcher from "../matchmaking/matcher";
import { stores } from "../store";
import { genderService } from "../gender/service";
import { detach } from "../../utils/detach";
import { AuthedSocket, BUS_CHANNEL, CALL_BUS_CHANNEL, getIo, setIo } from "./context";
import { messageLimiter, queueLimiter, reconnectTimers, signalLimiter } from "./context";
import {
  LAST_SEEN_THROTTLE_MS,
  callChargeTimers,
  lastSeenWrites,
  pendingCallCharges,
} from "./context";
import { authMiddleware } from "./auth";
import { onConnection } from "./session";
import { teardownPair } from "./pairs";
import { emitToUser } from "./delivery";
import { establishMatch } from "./queue";
import { markCallConnected } from "./billing";
import { persistSessionEnd } from "../pairing";

/**
 * Where the socket layer is assembled.
 *
 * This file used to be the whole layer — auth, matching, signalling, chat,
 * billing, teardown and timers in one nine-hundred-line run. Each of those is
 * now its own module and this is only the wiring: start the server, subscribe
 * to the bus, run the background timers, shut down.
 *
 * The split follows the section headings the file already had, because those
 * were the seams; what it adds is that the pieces can now be read, and
 * changed, without the rest in view.
 */

export type { AuthedSocket, SocketUser } from "./context";

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
  const io = new Server(httpServer, {
    cors: {
      origin: env.IS_PROD ? [env.CLIENT_URL, ...env.ALLOWED_ORIGINS] : true,
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60_000,
    pingInterval: 25_000,
    maxHttpBufferSize: 5e6, // gender frames travel over this channel
  });

  setIo(io);

  io.use(authMiddleware);

  io.on("connection", (socket: Socket) => {
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

  // A call coming up, anywhere. Only the node holding the pending charge for
  // that room does anything with it.
  await store.bus.subscribe(CALL_BUS_CHANNEL, (message) => {
    const roomId = (message as { roomId?: string } | null)?.roomId;
    if (typeof roomId === "string") markCallConnected(roomId);
  });

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
      const socket = getIo()?.sockets.sockets.get(socketId);
      socket?.emit(event, payload);
    })(), "socket:background");
  });
}

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

      // One entry per user who has ever connected, otherwise it only grows.
      // Dropping an expired one costs at most a redundant write.
      const staleBefore = Date.now() - LAST_SEEN_THROTTLE_MS;
      for (const [userId, at] of lastSeenWrites) {
        if (at < staleBefore) lastSeenWrites.delete(userId);
      }
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

  /*
   * Cancel pending charges rather than letting them fire.
   *
   * Below, every pair is torn down. A charge timer that outlives that would
   * come due for a call this server no longer has any record of, and bill a
   * real balance for it. When the process exits these die with it either
   * way; when it does not — a test suite calling shutdown between cases, a
   * restart in place — they used to survive and charge.
   *
   * Not charging for an interrupted call is the right direction to fail.
   */
  for (const timer of callChargeTimers.values()) clearTimeout(timer);
  callChargeTimers.clear();
  pendingCallCharges.clear();
  lastSeenWrites.clear();

  const pairs = await stores().pairing.allPairs();
  await Promise.allSettled(
    pairs.map((pair) => persistSessionEnd(pair, "server_shutdown", null)),
  );

  getIo()?.emit("server-shutdown", {});
  await new Promise<void>((resolve) => {
    const io = getIo();
    if (!io) return resolve();
    io.close(() => resolve());
  });

  const store = stores();
  await store.queue.clear();
  await store.pairing.clear();
  await store.presence.clear();
  setIo(null);
}
