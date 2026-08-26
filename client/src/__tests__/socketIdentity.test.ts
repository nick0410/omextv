import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Signing out has to take the socket with it.
 *
 * The store held the token and the socket held a connection authenticated with
 * it, and only the first was cleared. The socket stayed up, still authenticated
 * as the person who had just left — still in presence, still matchable — and
 * because the module keeps one instance, the next person to sign in on that
 * browser was handed it. Their messages, and their charges, would have been
 * billed to the previous account.
 */

// Hoisted with the mock factory, which runs before the module body.
const h = vi.hoisted(() => {
  const sockets: {
    connected: boolean;
    auth: { token: string | null };
    disconnect: () => void;
  }[] = [];
  return { sockets };
});

vi.mock("socket.io-client", () => ({
  io: (_url: string, opts: { auth: { token: string | null } }) => {
    const socket = {
      connected: true,
      auth: opts.auth,
      io: { on: () => undefined },
      on: () => undefined,
      emit: () => undefined,
      disconnect: vi.fn(function (this: { connected: boolean }) {
        this.connected = false;
      }),
    };
    h.sockets.push(socket as never);
    return socket;
  },
}));

vi.mock("../lib/apiConfig", () => ({
  getSocketUrl: () => "http://localhost:3001",
  refreshRuntimeConfig: async () => false,
  getApiUrl: () => "http://localhost:3001",
}));

import { getSocket } from "../lib/socket";
import { useAuthStore } from "../store/authStore";

type Fake = { connected: boolean; auth: { token: string | null }; disconnect: ReturnType<typeof vi.fn> };

describe("signing out", () => {
  beforeEach(() => {
    h.sockets.length = 0;
    useAuthStore.setState({ token: "seed" });
    useAuthStore.getState().logout();
    h.sockets.length = 0;
  });

  it("disconnects the socket, so the account stops being matchable", () => {
    useAuthStore.setState({ token: "token-for-A" });
    const socket = getSocket() as unknown as Fake;
    expect(socket.connected).toBe(true);

    useAuthStore.getState().logout();

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.connected).toBe(false);
  });

  it("does not hand the next person the previous account's connection", () => {
    useAuthStore.setState({ token: "token-for-A" });
    const first = getSocket() as unknown as Fake;
    expect(first.auth.token).toBe("token-for-A");

    useAuthStore.getState().logout();

    // Someone else signs in on the same browser, without a reload.
    useAuthStore.setState({ token: "token-for-B" });
    const second = getSocket() as unknown as Fake;

    expect(second).not.toBe(first);
    expect(second.auth.token).toBe("token-for-B");
  });

  it("leaves a signed-in socket alone when something else in the store changes", () => {
    // Only losing the token is a sign-out. Other writes must not drop a live
    // connection out from under a call.
    useAuthStore.setState({ token: "token-for-A" });
    const socket = getSocket() as unknown as Fake;

    useAuthStore.setState({ user: { id: "1", username: "a" } as never });

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connected).toBe(true);
  });
});
