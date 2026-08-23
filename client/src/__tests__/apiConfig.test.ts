import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The runtime lookup is load-bearing: the deployed site learns where its API
 * lives from it, so every failure mode has to degrade to "use what the build
 * supplied" rather than to a blank page.
 *
 * The module reads import.meta.env at import time, so each case re-imports it
 * with a fresh module registry.
 */
async function load(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("VITE_API_URL", env.VITE_API_URL ?? "");
  vi.stubEnv("VITE_SOCKET_URL", env.VITE_SOCKET_URL ?? "");
  vi.stubEnv("VITE_CONFIG_URL", env.VITE_CONFIG_URL ?? "");
  return import("../lib/apiConfig");
}

const respond = (body: unknown, ok = true) =>
  vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  } as Response);

describe("runtime API config", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the build-time value when no lookup is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const m = await load({ VITE_API_URL: "https://built-in.example" });
    await m.loadRuntimeConfig();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.getApiUrl()).toBe("https://built-in.example");
  });

  it("lets the document override a stale baked-in host", async () => {
    vi.stubGlobal("fetch", respond({ apiUrl: "https://fresh.example" }));

    const m = await load({
      VITE_API_URL: "https://dead-tunnel.example",
      VITE_CONFIG_URL: "https://config.example/c.json",
    });
    await m.loadRuntimeConfig();

    expect(m.getApiUrl()).toBe("https://fresh.example");
    expect(m.getSocketUrl()).toBe("https://fresh.example");
  });

  it("asks past the browser cache", async () => {
    // Only the browser's. raw.githubusercontent.com keeps the query string out
    // of its cache key and answers with the same ETag either way, so an
    // upstream CDN still serves the old body until its max-age runs out. That
    // gap is refreshRuntimeConfig's job, not this parameter's.
    const fetchSpy = respond({ apiUrl: "https://fresh.example" });
    vi.stubGlobal("fetch", fetchSpy);

    const m = await load({ VITE_CONFIG_URL: "https://config.example/c.json" });
    await m.loadRuntimeConfig();

    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/[?&]t=\d+/);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });

  it("keeps the build-time value when the lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const m = await load({
      VITE_API_URL: "https://built-in.example",
      VITE_CONFIG_URL: "https://config.example/c.json",
    });
    await m.loadRuntimeConfig();

    expect(m.getApiUrl()).toBe("https://built-in.example");
  });

  it("ignores a document that is missing or malformed", async () => {
    for (const body of [{}, { apiUrl: "" }, { apiUrl: 42 }, null]) {
      vi.stubGlobal("fetch", respond(body));
      const m = await load({
        VITE_API_URL: "https://built-in.example",
        VITE_CONFIG_URL: "https://config.example/c.json",
      });
      await m.loadRuntimeConfig();
      expect(m.getApiUrl()).toBe("https://built-in.example");
    }
  });

  it("ignores a non-200 response", async () => {
    vi.stubGlobal("fetch", respond({ apiUrl: "https://attacker.example" }, false));

    const m = await load({
      VITE_API_URL: "https://built-in.example",
      VITE_CONFIG_URL: "https://config.example/c.json",
    });
    await m.loadRuntimeConfig();

    expect(m.getApiUrl()).toBe("https://built-in.example");
  });

  it("gives up rather than blocking startup forever", async () => {
    // A hung CDN must not hold the whole app on a white screen.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      ),
    );

    const m = await load({
      VITE_API_URL: "https://built-in.example",
      VITE_CONFIG_URL: "https://config.example/c.json",
    });
    await m.loadRuntimeConfig(20);

    expect(m.getApiUrl()).toBe("https://built-in.example");
  });

  describe("refreshRuntimeConfig", () => {
    /*
     * A tab that is already open holds one API host for its whole life. When
     * the tunnel restarts that host stops resolving, and nothing in socket.io
     * will ever try a different one — so the only route back is noticing the
     * address changed. These cover the two answers that decision turns on.
     */
    it("reports a move when the host has changed", async () => {
      vi.stubGlobal("fetch", respond({ apiUrl: "https://first.example" }));
      const m = await load({ VITE_CONFIG_URL: "https://config.example/c.json" });
      await m.loadRuntimeConfig();

      vi.stubGlobal("fetch", respond({ apiUrl: "https://second.example" }));
      expect(await m.refreshRuntimeConfig()).toBe(true);
      expect(m.getSocketUrl()).toBe("https://second.example");
    });

    it("reports no move when the document still names the same host", async () => {
      // What a stale CDN answer looks like. Treating it as a move would put
      // the page into a reload loop until the cache expired.
      vi.stubGlobal("fetch", respond({ apiUrl: "https://same.example" }));
      const m = await load({ VITE_CONFIG_URL: "https://config.example/c.json" });
      await m.loadRuntimeConfig();

      expect(await m.refreshRuntimeConfig()).toBe(false);
    });

    it("reports no move when the lookup fails outright", async () => {
      vi.stubGlobal("fetch", respond({ apiUrl: "https://known.example" }));
      const m = await load({ VITE_CONFIG_URL: "https://config.example/c.json" });
      await m.loadRuntimeConfig();

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      expect(await m.refreshRuntimeConfig()).toBe(false);
      expect(m.getSocketUrl()).toBe("https://known.example");
    });
  });
});
