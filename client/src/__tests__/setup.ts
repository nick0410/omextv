import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

/*
 * jsdom has no layout engine and no media stack, so anything that reads
 * geometry or touches WebRTC has to be stubbed. These are the minimum needed
 * for components to render; tests that care about specific behaviour override
 * them locally.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// jsdom defines play() but it throws "Not implemented" and returns undefined,
// so it has to be replaced outright rather than filled in only when missing —
// real browsers return a promise and the app chains .catch() onto it.
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
