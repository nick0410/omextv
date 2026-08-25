import { Socket } from "socket.io";

import { stores } from "../store";
import { BUS_CHANNEL, getIo } from "./context";

/**
 * Getting an event to a person, wherever their socket happens to live.
 */

export async function liveSocketFor(userId: string): Promise<Socket | null> {
  const socketId = await stores().presence.socketOf(userId);
  const io = getIo();
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
export async function emitToUser(userId: string, event: string, payload: unknown): Promise<boolean> {
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
