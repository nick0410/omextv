import { io, Socket } from "socket.io-client";
import { useAuthStore } from "../store/authStore";
import { getSocketUrl, refreshRuntimeConfig } from "./apiConfig";

let socket: Socket | null = null;
let healing = false;

export function getSocket(): Socket {
  if (!socket) {
    const token = useAuthStore.getState().token;
    socket = io(getSocketUrl(), {
      auth: { token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    // Reconnection gives up after five tries, and the host it was given is
    // fixed for the life of the connection. Both are fine when the API has a
    // stable address; neither is, here.
    socket.io.on("reconnect_failed", () => {
      void healIfMoved();
    });
  }
  return socket;
}

/**
 * The API's address is not permanent, so "unreachable" is not always fatal.
 *
 * The tunnel hands out a new hostname every time it restarts — a sleeping
 * laptop is enough — and this tab is still holding the old one, which now
 * resolves to nothing. Reconnecting to the same dead address, however many
 * times, cannot work. Looking the address up again can.
 *
 * The reload is deliberately conditional on the host having actually changed.
 * The published document sits behind a five-minute CDN cache, so for a while
 * after a restart it still names the dead host; reloading on that answer would
 * spin — fail, reload, fail — until the cache expired. Only a genuine move
 * reloads, which can happen at most once per move.
 */
async function healIfMoved(): Promise<void> {
  if (healing) return;
  healing = true;
  try {
    if (await refreshRuntimeConfig()) window.location.reload();
  } catch {
    // Nothing better to try; the UI already shows the connection as lost.
  } finally {
    healing = false;
  }
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function reconnectSocket(): void {
  disconnectSocket();
  getSocket();
}
