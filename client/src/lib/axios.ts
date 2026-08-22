import axios from "axios";
import { useAuthStore } from "../store/authStore";
import { getApiUrl } from "./apiConfig";

const api = axios.create({
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

api.interceptors.request.use((config) => {
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
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);

export default api;
