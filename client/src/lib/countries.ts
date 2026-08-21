/**
 * Country display helpers.
 *
 * Names come from `Intl.DisplayNames`, which every current browser ships, and
 * flags are derived arithmetically from the ISO code — so there is no 249-row
 * table to hand-maintain and drift out of date.
 */

const displayNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

const nameCache = new Map<string, string>();

export function countryName(code: string): string {
  const upper = code.toUpperCase();
  const cached = nameCache.get(upper);
  if (cached) return cached;

  let name = upper;
  try {
    name = displayNames?.of(upper) ?? upper;
  } catch {
    // An unknown or malformed code: fall back to showing the code itself.
  }
  nameCache.set(upper, name);
  return name;
}

/**
 * Turn "IN" into 🇮🇳.
 *
 * A flag emoji is just its two letters as Regional Indicator Symbols, which
 * sit 0x1F1E6 above 'A'. Platforms that do not draw flags (Windows, notably)
 * render the two letters instead — still readable, just not a picture.
 */
export function countryFlag(code: string): string {
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return "";
  return String.fromCodePoint(
    ...[...upper].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)),
  );
}

export interface CountryOption {
  code: string;
  name: string;
  flag: string;
  /** How many people from there are online right now. */
  online: number;
}

export function buildOptions(
  codes: readonly string[],
  online: Record<string, number>,
): CountryOption[] {
  return codes.map((code) => ({
    code,
    name: countryName(code),
    flag: countryFlag(code),
    online: online[code] ?? 0,
  }));
}

/** Case- and accent-insensitive match on either the name or the code. */
export function matchesQuery(option: CountryOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    option.code.toLowerCase().startsWith(q) ||
    option.name.toLowerCase().includes(q)
  );
}

/** People online first, then alphabetically — the useful order, not the ISO one. */
export function sortOptions(options: CountryOption[]): CountryOption[] {
  return [...options].sort((a, b) => {
    if (a.online !== b.online) return b.online - a.online;
    return a.name.localeCompare(b.name);
  });
}
