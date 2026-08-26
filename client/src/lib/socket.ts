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

/**
 * Signing out has to take the connection with it.
 *
 * The socket authenticates once, at the handshake, and the server has no
 * reason to ask again — so clearing the token here left a connection up that
 * was still the account that had just left: still in presence, still in the
 * queue, still able to be matched with a stranger who would find nobody there.
 *
 * And because this module keeps a single instance, getSocket() handed that
 * same connection to whoever signed in next on the browser. Their messages
 * would have been sent as the previous account, and their calls charged to it.
 *
 * Watching the store rather than exporting something for the sign-out button
 * to remember to call: the button is not the only way the token goes away —
 * the interceptor drops it on any 401 — and a rule that has to be repeated at
 * each call site is one that eventually is not.
 *
 * Subscribed here because this module already depends on the store; the other
 * direction would be a cycle.
 */
useAuthStore.subscribe((state, previous) => {
  if (previous.token && !state.token) disconnectSocket();
});

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
