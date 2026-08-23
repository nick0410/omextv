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

  it("cache-busts, because the document is served from a CDN", async () => {
    const fetchSpy = respond({ apiUrl: "https://fresh.example" });
    vi.stubGlobal("fetch", fetchSpy);

    const m = await load({ VITE_CONFIG_URL: "https://config.example/c.json" });
    await m.loadRuntimeConfig();

    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/[?&]t=\d+/);
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
});
