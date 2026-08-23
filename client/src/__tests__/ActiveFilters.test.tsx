import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActiveFilters } from "../components/ActiveFilters";
import type { MatchFilters } from "../lib/types";

const filters = (over: Partial<MatchFilters> = {}): MatchFilters => ({
  gender: "any",
  countries: [],
  city: null,
  ...over,
});

const props = {
  online: {} as Record<string, number>,
  queued: false,
  onClearAll: () => {},
};

describe("ActiveFilters", () => {
  it("stays out of the way when nothing is restricted", () => {
    const { container } = render(<ActiveFilters {...props} filters={filters()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the country restriction", () => {
    render(<ActiveFilters {...props} filters={filters({ countries: ["IN", "DE"] })} />);
    expect(screen.getByText(/India/)).toBeInTheDocument();
    expect(screen.getByText(/Germany/)).toBeInTheDocument();
  });

  it("names a gender restriction nobody typed in", () => {
    // The detected-gender default applies this silently. Two friends of the
    // same gender each get pointed at the other one and can never match, so
    // it has to be visible.
    render(<ActiveFilters {...props} filters={filters({ gender: "female" })} />);
    expect(screen.getByText("Women")).toBeInTheDocument();
  });

  it("warns when the chosen countries have nobody in them", () => {
    render(
      <ActiveFilters
        {...props}
        filters={filters({ countries: ["AW"] })}
        online={{ IN: 2 }}
        queued
      />,
    );
    expect(screen.getByText(/will not match/i)).toBeInTheDocument();
  });

  it("stays quiet until the counts are actually known", () => {
    // An empty map means "not loaded yet", not "nobody anywhere" — warning on
    // it would fire on every page load before the first poll returns.
    render(<ActiveFilters {...props} filters={filters({ countries: ["AW"] })} online={{}} />);
    expect(screen.queryByText(/will not match/i)).toBeNull();
    expect(screen.queryByText(/Nobody from there/i)).toBeNull();
  });

  it("says nothing alarming when someone is reachable", () => {
    render(
      <ActiveFilters {...props} filters={filters({ countries: ["IN"] })} online={{ IN: 3 }} />,
    );
    expect(screen.queryByText(/Nobody from there/i)).toBeNull();
  });

  it("offers one action that clears everything", async () => {
    const onClearAll = vi.fn();
    render(
      <ActiveFilters
        {...props}
        filters={filters({ gender: "male", countries: ["IN"] })}
        onClearAll={onClearAll}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Match anyone" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("still offers the escape when only gender is restricting", async () => {
    const onClearAll = vi.fn();
    render(
      <ActiveFilters {...props} filters={filters({ gender: "male" })} onClearAll={onClearAll} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Match anyone" }));
    expect(onClearAll).toHaveBeenCalled();
  });
});
