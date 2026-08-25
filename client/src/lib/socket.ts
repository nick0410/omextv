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
      /*
       * Long enough to outlast a cold start.
       *
       * Five tries a second apart gave up after five seconds. The API sleeps
       * after fifteen idle minutes and takes about a minute to come back, so
       * the socket was guaranteed to stop trying while the server was still
       * starting — and then sat there, connected to nothing, with the page
       * insisting it was offline.
       *
       * The delay grows so a genuinely dead server is not hammered for two
       * minutes at one request a second.
       */
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      timeout: 30_000,
    });

    // Reconnection does eventually give up, and the host it was given is
    // fixed for the life of the connection. Neither matters while the API
    // keeps one address; both did while it lived behind a tunnel whose
    // hostname changed on every restart, and would again if it ever moves.
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
