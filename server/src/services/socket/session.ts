import { env } from "../../config/env";
import * as matcher from "../matchmaking/matcher";
import { stores } from "../store";
import { detach } from "../../utils/detach";
import { prisma } from "../../config/database";
import {
  AuthedSocket,
  LAST_SEEN_THROTTLE_MS,
  getIo,
  lastSeenWrites,
  reconnectTimers,
} from "./context";
import { emitToUser } from "./delivery";
import { livePairFor, onLeaveChat, teardownPair } from "./pairs";
import { onJoinQueue, onLeaveQueue } from "./queue";
import { onCallConnected, onChatMessage, onSignal, onTyping } from "./messaging";
import { isGenderVerified, onVerifyGender } from "./verification";
import { coins } from "../coins";

/**
 * A connection's whole life: coming up, what it is allowed to do, and going
 * away again.
 */

export async function onConnection(socket: AuthedSocket): Promise<void> {
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
      const old = getIo()?.sockets.sockets.get(evictedSocketId);
      old?.emit("session-replaced", { reason: "signed_in_elsewhere" });
      old?.disconnect(true);
    }
  })();

  registerHandlers(socket, ready);
  await ready;

  markSeen(user.id);

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

  /*
   * Restore an interrupted chat — but only a real one.
   *
   * Resuming into a room whose other side is gone puts someone back in a
   * conversation with nobody, and then refuses to let them queue because they
   * are "in a chat". That is the same stale row, reached from the other
   * direction.
   */
  const existingPair = await livePairFor(user.id);
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

/**
 * Record that this person was here.
 *
 * The column existed from the first migration and nothing ever wrote to it, so
 * it read null for every account that had ever signed in — which made it
 * impossible to tell a customer who came back from one who registered once and
 * left. Connecting a socket is the honest signal: reaching it means they got
 * past the login screen and into the app.
 *
 * Deliberately not awaited. Whether a call succeeds changes a statistic, not
 * whether somebody can use the app, so it must never delay a connection or
 * fail one.
 */
function markSeen(userId: string): void {
  const now = Date.now();
  const written = lastSeenWrites.get(userId) ?? 0;
  if (now - written < LAST_SEEN_THROTTLE_MS) return;
  lastSeenWrites.set(userId, now);

  detach(
    prisma.user
      .update({ where: { id: userId }, data: { lastSeenAt: new Date(now) } })
      .then(() => undefined)
      .catch(() => {
        // Let the next connection try again rather than holding the slot.
        lastSeenWrites.delete(userId);
      }),
    "socket:last-seen",
  );
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

  // The clock for a per-call charge starts here, not at the match: being
  // paired is not being connected.
  socket.on("call-connected", () => gate("socket:call-connected", () => onCallConnected(socket)));

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
