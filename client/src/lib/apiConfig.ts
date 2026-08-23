/**
 * Where the API lives, resolved at runtime rather than baked in at build time.
 *
 * Vite inlines `import.meta.env` values during the build, so changing the API
 * host meant a full rebuild and redeploy. That is fine for a stable host, but
 * the free setup runs behind a Cloudflare quick tunnel whose hostname changes
 * every time it restarts — and the laptop sleeping is enough to restart it.
 * The live site would then sit there pointing at a dead tunnel until someone
 * noticed and rebuilt.
 *
 * So the app fetches a small JSON document at boot instead. Moving the API
 * becomes a file edit that takes effect on the next page load, with no build
 * involved.
 *
 * The runtime document wins over the build-time value when both are present.
 * That is the whole point: the baked-in host is the fallback for when the
 * lookup fails, not the authority. A deployment with a stable API should set
 * only the build-time value and leave VITE_CONFIG_URL unset.
 */

const BUILD_TIME_API = import.meta.env.VITE_API_URL || "";
const BUILD_TIME_SOCKET = import.meta.env.VITE_SOCKET_URL || "";
const CONFIG_URL = import.meta.env.VITE_CONFIG_URL || "";

interface RuntimeConfig {
  apiUrl?: string;
  socketUrl?: string;
}

let apiUrl = BUILD_TIME_API;
let socketUrl = BUILD_TIME_SOCKET || BUILD_TIME_API;

export function getApiUrl(): string {
  return apiUrl;
}

export function getSocketUrl(): string {
  return socketUrl;
}

/**
 * Load the runtime config, if one is configured.
 *
 * Deliberately forgiving: a missing, slow or malformed document leaves the
 * build-time values in place rather than blocking startup. A failed config
 * lookup should degrade to "same origin", never to a blank page.
 */
export async function loadRuntimeConfig(timeoutMs = 4000): Promise<void> {
  if (!CONFIG_URL) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // `no-store` plus the timestamp stop the *browser* reusing a response.
    // Neither defeats an upstream CDN, and the one actually in use does not
    // care: raw.githubusercontent.com leaves the query string out of its cache
    // key, so the same stale body comes back under the same ETag until its
    // five-minute max-age expires. Measured, not assumed.
    //
    // So a change is invisible for up to five minutes, and this fetch cannot
    // fix that. refreshRuntimeConfig is the answer instead — the client
    // notices it cannot reach the host and looks again later.
    const url = `${CONFIG_URL}${CONFIG_URL.includes("?") ? "&" : "?"}t=${Date.now()}`;
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return;

    const config = (await response.json()) as RuntimeConfig;
    if (typeof config.apiUrl === "string" && config.apiUrl) {
      apiUrl = config.apiUrl;
      socketUrl = config.apiUrl;
    }
    if (typeof config.socketUrl === "string" && config.socketUrl) {
      socketUrl = config.socketUrl;
    }
  } catch {
    // Keep whatever the build supplied.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look the document up again, and report whether the API has moved.
 *
 * The host is only stable for as long as the tunnel is. When it restarts —
 * which the laptop sleeping is enough to cause — every tab already open is
 * holding a hostname that no longer resolves, and the published document takes
 * up to five minutes to stop serving that same dead hostname to new visitors.
 *
 * Neither case recovers on its own, so something has to look again. This is
 * the "again": call it when the host stops answering, and reconnect if it
 * reports a move.
 */
export async function refreshRuntimeConfig(timeoutMs = 4000): Promise<boolean> {
  const before = socketUrl;
  await loadRuntimeConfig(timeoutMs);
  return socketUrl !== before;
}
