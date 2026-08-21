/**
 * ISO 3166-1 alpha-2.
 *
 * Country filters are matched by exact code, so free-text country names from
 * the client are rejected outright — "USA", "United States" and "us" would
 * otherwise silently never match a stored "US" and the user would sit in the
 * queue forever wondering why.
 */
export const COUNTRY_CODES = [
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
] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

const COUNTRY_SET: ReadonlySet<string> = new Set(COUNTRY_CODES);

export function isValidCountry(code: unknown): code is CountryCode {
  return typeof code === "string" && COUNTRY_SET.has(code.toUpperCase());
}

/** Uppercase and validate, or null. */
export function normalizeCountry(code: unknown): CountryCode | null {
  if (typeof code !== "string") return null;
  const upper = code.trim().toUpperCase();
  return COUNTRY_SET.has(upper) ? (upper as CountryCode) : null;
}

/**
 * Normalize a requested country list, dropping invalid entries and duplicates.
 * `maxCountries` caps how wide a single filter can be, so one client cannot
 * force a 200-entry `includes` scan on every compatibility check.
 */
export function normalizeCountryList(input: unknown, maxCountries = 10): CountryCode[] {
  if (!Array.isArray(input)) return [];
  const out: CountryCode[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= maxCountries) break;
    const code = normalizeCountry(raw);
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}
