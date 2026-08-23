/**
 * Country display helpers.
 *
 * Names come from `Intl.DisplayNames`, which every current browser ships, and
 * flags are derived arithmetically from the ISO code — so there is no 249-row
 * table to hand-maintain and drift out of date.
 */

/**
 * ISO 3166-1 alpha-2, bundled rather than fetched.
 *
 * This list is a fixed standard, so a network round-trip to learn it buys
 * nothing and costs everything: when the API is unreachable the picker used to
 * come up empty, which reads as "my country is missing" rather than "the
 * backend is down". The server keeps its own copy for validation and
 * countries.test.ts fails if the two ever drift apart.
 */
export const COUNTRY_CODES: readonly string[] = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS",
  "BT","BV","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN",
  "CO","CR","CU","CV","CW","CX","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE",
  "EG","EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF",
  "GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY","HK","HM",
  "HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM",
  "JO","JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC",
  "LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK",
  "ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA",
  "NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG",
  "PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW",
  "SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS",
  "ST","SV","SX","SY","SZ","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO",
  "TR","TT","TV","TW","TZ","UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI",
  "VN","VU","WF","WS","YE","YT","ZA","ZM","ZW",
];

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
