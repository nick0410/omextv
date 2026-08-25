import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { WakingNotice } from "../components/WakingNotice";

/**
 * The message shown while a sleeping server starts.
 *
 * Its whole job is to be absent almost always. A free-plan instance stops
 * after fifteen idle minutes, so this appears once an evening and must not
 * flicker on every fast request in between — a spinner that shows up
 * constantly teaches people to ignore it, and then it is useless on the one
 * occasion that matters.
 */

const listeners = new Set<(waking: boolean) => void>();

vi.mock("../lib/axios", () => ({
  onServerWaking: (fn: (waking: boolean) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  default: {},
}));

const emit = (waking: boolean) => act(() => listeners.forEach((fn) => fn(waking)));

beforeEach(() => {
  listeners.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the waking notice", () => {
  it("shows nothing while the server is answering normally", () => {
    const { container } = render(<WakingNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains the wait once a request is slow", () => {
    render(<WakingNotice />);
    emit(true);

    // Says what is happening and roughly how long, which is the difference
    // between waiting and leaving.
    expect(screen.getByRole("status")).toHaveTextContent(/waking the server up/i);
    expect(screen.getByRole("status")).toHaveTextContent(/about a minute/i);
  });

  it("disappears the moment the server answers", () => {
    const { container } = render(<WakingNotice />);
    emit(true);
    expect(screen.queryByRole("status")).toBeInTheDocument();

    emit(false);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the seconds once the wait is long enough to doubt", () => {
    // Without a moving number a slow page is indistinguishable from a stuck
    // one, which is exactly when someone closes the tab.
    render(<WakingNotice />);
    emit(true);

    expect(screen.getByRole("status").textContent).not.toMatch(/\(\d+s\)/);

    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole("status").textContent).toMatch(/\(\d+s\)/);
  });

  it("starts counting again from zero on the next wait", () => {
    render(<WakingNotice />);
    emit(true);
    act(() => vi.advanceTimersByTime(8000));
    emit(false);

    emit(true);
    // A stale count carried over from the last time would read as a wait that
    // is already failing.
    expect(screen.getByRole("status").textContent).not.toMatch(/\(\d+s\)/);
  });

  it("stops its timer when it goes away", () => {
    const { unmount } = render(<WakingNotice />);
    emit(true);
    unmount();

    // Nothing should still be ticking against an unmounted component.
    expect(() => act(() => vi.advanceTimersByTime(5000))).not.toThrow();
  });
});
