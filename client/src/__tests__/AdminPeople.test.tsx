import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The list of people, which is the part of this page that is about individuals
 * rather than totals.
 *
 * Driven through the page's own data path rather than by rendering a table in
 * isolation: what is worth checking is that a row survives the fetch, the
 * shaping and the formatting — a count of seven is no use if the seven rows
 * are blank.
 */

const get = vi.fn();
vi.mock("../lib/axios", () => ({ default: { get: (...a: unknown[]) => get(...a) } }));
vi.mock("../lib/apiConfig", () => ({
  getApiUrl: () => "http://localhost:3001",
  getSocketUrl: () => "http://localhost:3001",
  refreshRuntimeConfig: async () => false,
}));

import Admin from "../pages/Admin";

const HOUR = 3600_000;

const overview = {
  checkedAt: new Date().toISOString(),
  problems: [],
  health: { dbOk: true, storeOk: true, store: "redis", version: "2.1.0", env: "test", uptimeSec: 60 },
  payments: {
    provider: "upi", configured: true, confirmsAutomatically: false,
    mode: null, webhookReady: null, upiConfigured: true, adminCount: 2,
  },
  calls: { hasTurn: false, stunCount: 2, requiresVerification: false },
  live: { online: 0, activeChats: 0, queued: 0, queuedPremium: 0, queuedStandard: 0, oldestWaitMs: 0 },
  users: { total: 2, today: 1, week: 2, premium: 1, banned: 0, synthetic: 0 },
  money: { grossPaise: 0, byStatus: {}, awaitingReview: 0, stale: 0, coinsOutstanding: 0 },
  chats: { today: 0, week: 0, reportsWeek: 0 },
  recentOrders: [],
  people: [
    {
      id: "1", username: "crimson", email: "crimson@example.com",
      gender: "female", verifiedGender: null, country: "IN",
      coins: 250, isPremium: true, isBanned: false, reportsAgainst: 0,
      createdAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      lastSeenAt: new Date(Date.now() - HOUR).toISOString(),
    },
    {
      id: "2", username: "mismatch", email: "mismatch@example.com",
      gender: "female", verifiedGender: "male", country: null,
      coins: 0, isPremium: false, isBanned: true, reportsAgainst: 3,
      createdAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
      lastSeenAt: null,
    },
  ],
};

const show = () => render(<MemoryRouter><Admin /></MemoryRouter>);

describe("the list of people", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: overview });
  });

  it("shows a row for each account, with the balance", async () => {
    show();
    expect(await screen.findByText("crimson")).toBeInTheDocument();
    expect(screen.getByText("crimson@example.com")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
  });

  it("says how long ago rather than printing a timestamp", async () => {
    show();
    // Seen an hour ago; joined two.
    await waitFor(() => expect(screen.getByText("1h")).toBeInTheDocument());
    expect(screen.getByText("2h")).toBeInTheDocument();
  });

  it("says never for an account that has not been back since it was made", async () => {
    show();
    expect(await screen.findByText("never")).toBeInTheDocument();
  });

  it("marks the accounts worth looking at", async () => {
    show();
    expect(await screen.findByText("premium")).toBeInTheDocument();
    expect(screen.getByText("banned")).toBeInTheDocument();
    expect(screen.getByText("3 reports")).toBeInTheDocument();
  });

  it("flags a detected gender only when it disagrees with the declared one", async () => {
    show();
    // The second account said female and was seen as male.
    expect(await screen.findByText(/seen male/)).toBeInTheDocument();
    // The first agreed with itself, so nothing is added to its row.
    expect(screen.queryByText(/seen female/)).not.toBeInTheDocument();
  });

  it("says so plainly when nobody has signed up", async () => {
    get.mockResolvedValue({ data: { ...overview, people: [] } });
    show();
    expect(await screen.findByText("Nobody has signed up yet.")).toBeInTheDocument();
  });
});
