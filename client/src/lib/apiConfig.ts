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
 * The build-time value still wins when present, and is what a real deployment
 * should use — the remote lookup only fills in when it is absent.
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
    // Cache-bust: the document is served from a CDN that would otherwise keep
    // handing out the previous tunnel hostname for minutes after a change.
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
