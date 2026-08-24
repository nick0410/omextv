import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { FilterPanel } from "../components/FilterPanel";
import type { MatchFilters } from "../lib/types";

vi.mock("../lib/axios", () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { countries: [] } }) },
}));

vi.mock("../hooks/useOnlineCountries", () => ({
  useOnlineCountries: () => ({}),
}));

const filters = (over: Partial<MatchFilters> = {}): MatchFilters => ({
  gender: "any",
  countries: [],
  city: null,
  ...over,
});

function panel(over: Partial<React.ComponentProps<typeof FilterPanel>> = {}) {
  const onChange = vi.fn();
  render(
    <MemoryRouter>
      <FilterPanel
        filters={filters()}
        onChange={onChange}
        disabled={false}
        suggested={null}
        isPremium={false}
        {...over}
      />
    </MemoryRouter>,
  );
  return { onChange };
}

/**
 * The paywall as the user meets it.
 *
 * None of this is the actual restriction — the server clamps the filters when
 * the join arrives — so these tests are about the pitch, not the enforcement:
 * the controls stay visible, they do not work, and the way to make them work
 * is one tap away.
 */
describe("FilterPanel locking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("still shows the premium options to a free account", () => {
    // Hiding them would make the app look simpler and sell nothing.
    panel({ isPremium: false });

    expect(screen.getByRole("button", { name: "Women" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Men" })).toBeInTheDocument();
  });

  it("does not let a free account pick a gender", async () => {
    const { onChange } = panel({ isPremium: false });

    await userEvent.click(screen.getByRole("button", { name: "Women" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves Anyone usable, because that is what free accounts get", () => {
    panel({ isPremium: false });
    expect(screen.getByRole("button", { name: "Anyone" })).toBeEnabled();
  });

  it("does not open the country picker for a free account", async () => {
    panel({ isPremium: false });

    const country = screen.getByRole("button", { name: /Anywhere/ });
    expect(country).toBeDisabled();
    await userEvent.click(country);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("points at the price rather than just refusing", async () => {
    panel({ isPremium: false });

    const links = screen.getAllByRole("link", { name: /unlock with coins/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute("href", "/coins");
  });

  it("hands a premium account the controls with no lock in sight", async () => {
    const { onChange } = panel({ isPremium: true });

    expect(screen.queryByRole("link", { name: /unlock with coins/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Women" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gender: "female" }));
  });

  it("hides the city box from a free account even with a country saved", () => {
    // Saved filters survive a lapsed pass, so this state is reachable without
    // the user doing anything — and a city box that cannot apply is noise.
    panel({ isPremium: false, filters: filters({ countries: ["IN"] }) });
    expect(screen.queryByLabelText(/city/i)).toBeNull();
  });

  it("keeps everything locked while the call is in progress too", () => {
    // `disabled` and `isPremium` are separate reasons to refuse; neither may
    // cancel the other out.
    panel({ isPremium: true, disabled: true });
    expect(screen.getByRole("button", { name: "Women" })).toBeDisabled();
  });
});
