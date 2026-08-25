import axios from "axios";
import { useAuthStore } from "../store/authStore";
import { getApiUrl } from "./apiConfig";

/*
 * Long enough for a sleeping server to get up.
 *
 * The API runs on a free plan that stops the instance after fifteen idle
 * minutes and starts it again on the next request, which takes roughly a
 * minute. A normal timeout turns that into "something went wrong" for the
 * first person to arrive all evening — who then leaves, and the second person
 * finds nobody there.
 *
 * Waiting is the right answer for the request that wakes it. What is not
 * acceptable is waiting silently, so the store below tracks it and the sign-in
 * screen says what is happening.
 */
const WAKE_TIMEOUT_MS = 90_000;

const api = axios.create({
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
  timeout: WAKE_TIMEOUT_MS,
});

/**
 * Whether a request has been waiting long enough to be a cold start.
 *
 * A module-level listener rather than state threaded through every caller:
 * anything can subscribe, and nothing has to know which request triggered it.
 */
type WakeListener = (waking: boolean) => void;
const wakeListeners = new Set<WakeListener>();
let inFlight = 0;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

export function onServerWaking(listener: WakeListener): () => void {
  wakeListeners.add(listener);
  return () => wakeListeners.delete(listener);
}

function announce(waking: boolean) {
  for (const listener of wakeListeners) listener(waking);
}

// Two seconds: past that, something is slower than a working server ever is.
const SLOW_AFTER_MS = 2_000;

function requestStarted() {
  inFlight++;
  if (wakeTimer) return;
  wakeTimer = setTimeout(() => announce(true), SLOW_AFTER_MS);
}

function requestFinished() {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight > 0) return;
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  announce(false);
}

api.interceptors.request.use((config) => {
  requestStarted();
  // Resolved per request, not at module load: the runtime config arrives
  // after this file is first evaluated.
  config.baseURL = `${getApiUrl()}/api`;

  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => {
    requestFinished();
    /*
     * Reject an HTML body that arrived where JSON was expected.
     *
     * A single-page host answers unknown paths with index.html and a 200, so a
     * missing or misconfigured API turns every call into a "successful"
     * response whose body is a page. Callers then read `res.data.countries`
     * off a string, get undefined, and the first `.map()` throws — which
     * renders as a blank screen with the real cause nowhere near it.
     *
     * Failing here instead means the caller's own .catch() runs, exactly as it
     * would for a real 404.
     */
    const contentType = String(response.headers?.["content-type"] ?? "");
    if (contentType.includes("text/html")) {
      return Promise.reject(
        new Error(
          `Expected JSON from ${response.config?.url ?? "the API"} but received HTML. ` +
            `The API is probably not reachable at this origin — set VITE_API_URL.`,
        ),
      );
    }
    return response;
  },
  (error) => {
    requestFinished();
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);

export default api;
