import { stores } from "../store";
import { persistSessionEnd } from "../pairing";
import type { PairRecord } from "../store/types";
import { EndReason } from "../../types";
import { AuthedSocket } from "./context";
import { cancelCallCharge } from "./billing";
import { emitToUser, liveSocketFor } from "./delivery";

/**
 * The life of a pair: whether one is real, and how it ends.
 */

/**
 * Is this pair still a conversation, or just a record of one?
 *
 * A pair row outlives the sockets it describes. The reconnect grace timer that
 * would clean it up lives in this process's memory, so a restart loses every
 * pending teardown and the rows stay behind — and `isPaired` believed them.
 * The result is someone who has left a chat being told they are still in one,
 * with nothing they can do about it: the room is gone, so there is nothing to
 * skip or end.
 *
 * Presence is the truth and the pair row is a cache of it. A partner who is
 * not connected is not in a conversation, whatever the row says, so the row is
 * cleared and the caller carries on.
 *
 * Checked where it hurts rather than swept on a timer, because a sweep leaves
 * a window and this is the window someone is standing in.
 *
 * @returns the pair if it is genuinely live, otherwise null.
 */
export async function livePairFor(userId: string): Promise<PairRecord | null> {
  const store = stores();
  const pair = await store.pairing.pairOf(userId);
  if (!pair) return null;

  const partnerId = pair.userAId === userId ? pair.userBId : pair.userAId;
  if (await store.presence.isOnline(partnerId)) return pair;

  // The other side is gone. Tear it down so both are free, and tell them if
  // they happen to come back.
  await teardownPair(pair.roomId, "disconnect", null);
  await emitToUser(partnerId, "partner-left", {
    reason: "disconnect",
    roomId: pair.roomId,
  });
  return null;
}

export async function onLeaveChat(
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
export async function teardownPair(
  roomId: string,
  reason: EndReason,
  endedById: string | null,
): Promise<void> {
  // A call that ends before the threshold is not charged for. Cancelling here
  // rather than checking at fire time keeps the rule in one place: the timer
  // firing *is* the call having lasted.
  cancelCallCharge(roomId);

  const pair = await stores().pairing.end(roomId);
  if (!pair) return;

  for (const userId of [pair.userAId, pair.userBId]) {
    (await liveSocketFor(userId))?.leave(roomId);
  }

  await persistSessionEnd(pair, reason, endedById);
}
