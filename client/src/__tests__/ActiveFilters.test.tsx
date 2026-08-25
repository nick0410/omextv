import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
  restricted: [] as Array<"gender" | "country">,
  isPremium: true,
  onClearAll: () => {},
};

/**
 * The upsell links to the price page, so the component needs a router. Wrapping
 * every case keeps the two branches — restricted and not — rendering the same
 * way, rather than one of them quietly testing a different tree.
 */
function renderFilters(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("ActiveFilters", () => {
  it("stays out of the way when nothing is restricted", () => {
    const { container } = renderFilters(<ActiveFilters {...props} filters={filters()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the country restriction", () => {
    renderFilters(<ActiveFilters {...props} filters={filters({ countries: ["IN", "DE"] })} />);
    expect(screen.getByText(/India/)).toBeInTheDocument();
    expect(screen.getByText(/Germany/)).toBeInTheDocument();
  });

  it("names a gender restriction nobody typed in", () => {
    // The detected-gender default applies this silently. Two friends of the
    // same gender each get pointed at the other one and can never match, so
    // it has to be visible.
    renderFilters(<ActiveFilters {...props} filters={filters({ gender: "female" })} />);
    expect(screen.getByText("Women")).toBeInTheDocument();
  });

  it("warns when the chosen countries have nobody in them", () => {
    renderFilters(
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
    renderFilters(<ActiveFilters {...props} filters={filters({ countries: ["AW"] })} online={{}} />);
    expect(screen.queryByText(/will not match/i)).toBeNull();
    expect(screen.queryByText(/Nobody from there/i)).toBeNull();
  });

  it("says nothing alarming when someone is reachable", () => {
    renderFilters(
      <ActiveFilters {...props} filters={filters({ countries: ["IN"] })} online={{ IN: 3 }} />,
    );
    expect(screen.queryByText(/Nobody from there/i)).toBeNull();
  });

  it("offers one action that clears everything", async () => {
    const onClearAll = vi.fn();
    renderFilters(
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
    renderFilters(
      <ActiveFilters {...props} filters={filters({ gender: "male" })} onClearAll={onClearAll} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Match anyone" }));
    expect(onClearAll).toHaveBeenCalled();
  });
  describe("when the server refused the filters", () => {
    /*
     * A free account keeps its saved filters — they are just ignored. Without
     * this branch the bar would confidently describe a search that is not
     * happening, and the empty-queue warning would blame a country restriction
     * that was never applied.
     */
    it("says the filter was not applied, and offers the way to fix it", () => {
      renderFilters(
        <ActiveFilters
          {...props}
          filters={filters({ gender: "female" })}
          restricted={["gender"]}
        />,
      );

      expect(screen.getByText(/premium/i)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /unlock/i })).toHaveAttribute("href", "/coins");
    });

    it("names both restrictions when both were dropped", () => {
      renderFilters(
        <ActiveFilters
          {...props}
          filters={filters({ gender: "male", countries: ["IN"] })}
          restricted={["gender", "country"]}
        />,
      );

      expect(screen.getByText(/a gender and a country/i)).toBeInTheDocument();
    });

    it("does not claim the search is narrowed to a country", () => {
      // The countries were dropped, so listing them would describe a
      // restriction that is not in force.
      renderFilters(
        <ActiveFilters
          {...props}
          filters={filters({ countries: ["IN"] })}
          restricted={["country"]}
        />,
      );

      expect(screen.queryByText(/Searching/)).toBeNull();
      expect(screen.queryByText(/India/)).toBeNull();
    });

    it("suppresses the empty-queue warning, which would be about the wrong thing", () => {
      renderFilters(
        <ActiveFilters
          {...props}
          filters={filters({ countries: ["AW"] })}
          online={{ IN: 2 }}
          restricted={["country"]}
          queued
        />,
      );

      expect(screen.queryByText(/will not match/i)).toBeNull();
    });
  });
  describe("before the server has been asked", () => {
    /*
     * A free account's filters are ignored, and that was only said after the
     * first join. Until then the bar claimed "Searching Women" over a search
     * that was always going to be everyone — a promise the app could not keep
     * and then blamed on the paywall.
     */
    it("warns a free account up front, with nothing dropped yet", () => {
      renderFilters(
        <ActiveFilters {...props} filters={filters({ gender: "female" })} isPremium={false} />,
      );

      expect(screen.getByText(/a gender is premium/i)).toBeInTheDocument();
      expect(screen.queryByText(/Searching/)).toBeNull();
    });

    it("names both when both are set", () => {
      renderFilters(
        <ActiveFilters
          {...props}
          filters={filters({ gender: "male", countries: ["IN"] })}
          isPremium={false}
        />,
      );
      expect(screen.getByText(/a gender and a country/i)).toBeInTheDocument();
    });

    it("stays silent for a free account that asked for nothing", () => {
      const { container } = renderFilters(
        <ActiveFilters {...props} filters={filters()} isPremium={false} />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it("describes the search normally for a premium account", () => {
      renderFilters(
        <ActiveFilters {...props} filters={filters({ gender: "female" })} isPremium />,
      );
      expect(screen.getByText("Women")).toBeInTheDocument();
      expect(screen.queryByText(/is premium/i)).toBeNull();
    });
  });
});
