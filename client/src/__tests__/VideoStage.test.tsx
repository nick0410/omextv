import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VideoStage } from "../components/VideoStage";
import type { PartnerProfile } from "../lib/types";

const partner: PartnerProfile = {
  userId: "p1",
  username: "riya",
  gender: "female",
  genderVerified: true,
  country: "DE",
  city: null,
  isPremium: false,
};

const base = {
  localStream: null,
  remoteStream: null,
  phase: "idle" as const,
  partner: null,
  selfName: "you",
  isCameraOff: false,
  queuePosition: 0,
};

/** Tailwind's positioning utilities, which must never appear together. */
const POSITIONS = ["static", "relative", "absolute", "fixed", "sticky"];

describe("VideoStage", () => {
  it("never puts two positioning classes on one element", () => {
    /*
     * CSS resolves by stylesheet order, not by the order classes appear in the
     * attribute — so a base class list carrying `relative` beat an `absolute`
     * added afterwards, and the picture-in-picture tile silently stayed in the
     * flow and stretched to full height. Conflicting classes on one element
     * mean whichever wins is a coincidence.
     */
    const { container } = render(<VideoStage {...base} />);

    for (const el of container.querySelectorAll<HTMLElement>("*")) {
      const applied = [...el.classList].filter((c) => POSITIONS.includes(c));
      expect(applied.length, `"${el.className}" sets ${applied.join(" and ")}`).toBeLessThan(2);
    }
  });

  it("keeps the thumbnail a positioning context for its own overlay", () => {
    // lg:static once removed it, and the name plate inside escaped to the page.
    const { container } = render(<VideoStage {...base} />);
    const tiles = [...container.querySelectorAll("video")].map((v) => v.parentElement!);
    const [, local] = tiles;
    expect(local.className).toMatch(/\babsolute\b/);
    expect(local.className).toMatch(/lg:relative/);
    expect(local.className).not.toMatch(/lg:static/);
  });

  it("shows the partner's country, not just their name", () => {
    // The server has always sent it; it simply was not rendered, so the
    // country filter had no visible effect.
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    render(
      <VideoStage {...base} phase="live" remoteStream={stream} partner={partner} />,
    );
    expect(screen.getByText("riya")).toBeInTheDocument();
    expect(screen.getByText(/Germany/)).toBeInTheDocument();
  });

  it("includes the city when there is one", () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    render(
      <VideoStage
        {...base}
        phase="live"
        remoteStream={stream}
        partner={{ ...partner, city: "Berlin" }}
      />,
    );
    expect(screen.getByText(/Berlin, Germany/)).toBeInTheDocument();
  });

  it("does not label a partner before the call is live", () => {
    render(<VideoStage {...base} phase="connecting" partner={partner} />);
    expect(screen.queryByText("riya")).toBeNull();
  });

  it("reports the queue position while waiting", () => {
    render(<VideoStage {...base} phase="queued" queuePosition={3} />);
    expect(screen.getByText(/#3/)).toBeInTheDocument();
  });
});
