import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CountryPicker } from "../components/CountryPicker";
import { COUNTRY_CODES } from "../lib/countries";

/**
 * Find the row for exactly one country.
 *
 * Matching the accessible name with a regex is not enough — "India" is also a
 * substring of "British Indian Ocean Territory", so a loose matcher silently
 * picks the wrong row or throws on ambiguity.
 */
function option(name: string): HTMLElement {
  const row = screen
    .getAllByRole("option")
    .find((el) => within(el).queryByText(name, { exact: true }));
  if (!row) throw new Error(`no country row for "${name}"`);
  return row;
}

const base = {
  open: true,
  codes: COUNTRY_CODES,
  online: {} as Record<string, number>,
  selected: [] as string[],
  onClose: () => {},
  onChange: () => {},
};

describe("CountryPicker", () => {
  it("renders every country", () => {
    render(<CountryPicker {...base} />);
    expect(screen.getAllByRole("option")).toHaveLength(249);
  });

  it("renders into the body, not in place", () => {
    // It opens from inside a transformed sliding sheet on mobile, and a
    // transformed ancestor becomes the containing block for position:fixed —
    // so rendered in place it covered only the sheet.
    const { container } = render(<CountryPicker {...base} />);
    expect(container).toBeEmptyDOMElement();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("replaces the choice in single-select instead of keeping the old one", async () => {
    // The original toggle did `[...selected, code].slice(0, max)`, which with
    // max=1 kept the *existing* code and dropped the new one — so picking a
    // different country looked like a click that did nothing.
    const onChange = vi.fn();
    render(
      <CountryPicker {...base} maxSelected={1} selected={["IN"]} onChange={onChange} />,
    );

    await userEvent.click(option("Germany"));
    expect(onChange).toHaveBeenCalledWith(["DE"]);
  });

  it("leaves every other country clickable in single-select", () => {
    render(<CountryPicker {...base} maxSelected={1} selected={["IN"]} />);
    expect(option("Germany")).toBeEnabled();
  });

  it("stops adding past the limit in multi-select", () => {
    render(<CountryPicker {...base} maxSelected={2} selected={["IN", "DE"]} />);
    expect(option("France")).toBeDisabled();
    // Already-chosen rows stay clickable so they can be removed.
    expect(option("India")).toBeEnabled();
  });

  it("unselects a country that is already chosen", async () => {
    const onChange = vi.fn();
    render(<CountryPicker {...base} selected={["IN", "DE"]} onChange={onChange} />);
    await userEvent.click(option("India"));
    expect(onChange).toHaveBeenCalledWith(["DE"]);
  });

  it("filters by name and by code", async () => {
    render(<CountryPicker {...base} />);
    const search = screen.getByLabelText("Search countries");

    await userEvent.type(search, "germ");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    await userEvent.clear(search);
    await userEvent.type(search, "IN");
    // "IN" matches India by code; the code branch is what is under test.
    expect(option("India")).toBeInTheDocument();
  });

  it("shows how many people are online where", () => {
    render(<CountryPicker {...base} online={{ IN: 4 }} />);
    expect(screen.getByText("4 online")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<CountryPicker {...base} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(<CountryPicker {...base} open={false} />);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
