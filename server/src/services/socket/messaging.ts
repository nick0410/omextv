import { randomUUID } from "crypto";

import { env } from "../../config/env";
import { stores } from "../store";
import { detach } from "../../utils/detach";
import {
  AuthedSocket,
  CALL_BUS_CHANNEL,
  getIo,
  messageLimiter,
  signalLimiter,
} from "./context";
import { markCallConnected } from "./billing";

/**
 * Everything that travels between two people already in a room: the WebRTC
 * handshake, the text chat, and the typing indicator.
 */

/**
 * Relay an SDP/ICE payload to the other member of the room.
 *
 * Membership is checked against our own pairing registry rather than against
 * socket.io rooms: a client could previously emit into any roomId it guessed
 * and inject signalling into strangers' calls.
 */
export function onSignal(socket: AuthedSocket, event: string, payload: unknown): void {
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

export function onChatMessage(socket: AuthedSocket, payload: unknown): void {
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
    getIo()?.to(roomId).emit("chat-message", message);
  })(), "socket:background");
}

export function onTyping(socket: AuthedSocket, payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const { roomId, isTyping } = payload as { roomId?: unknown; isTyping?: unknown };
  if (typeof roomId !== "string") return;
  detach((async () => {
    if (!(await stores().pairing.isMember(socket.user.id, roomId))) return;
    socket.to(roomId).emit("typing", { userId: socket.user.id, isTyping: isTyping === true });
  })(), "socket:background");
}

/**
 * One end reporting that the call is actually up.
 *
 * The server relays the handshake but never learns whether it worked: an offer
 * and an answer crossing say the two ends are talking to this server, not to
 * each other. Only the peer connection knows, so only the client can say.
 *
 * The room is taken from the pair on record rather than from the payload —
 * this starts a clock that ends in a charge, and a client-supplied room id
 * would let anyone start one against a call they are not in.
 */
export async function onCallConnected(socket: AuthedSocket): Promise<void> {
  const store = stores();
  const pair = await store.pairing.pairOf(socket.user.id);
  if (!pair) return;

  markCallConnected(pair.roomId);

  /*
   * And tell the other instances.
   *
   * The charge is held by whichever node made the match, which need not be the
   * node this socket is on. Locally this is already done; the broadcast is for
   * the case where it is not, and is a no-op everywhere that holds nothing for
   * this room.
   */
  if (store.kind === "redis") {
    await store.bus.publish(CALL_BUS_CHANNEL, { roomId: pair.roomId });
  }
}
