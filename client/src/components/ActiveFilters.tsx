import { countryFlag, countryName } from "../lib/countries";
import type { MatchFilters } from "../lib/types";

interface Props {
  filters: MatchFilters;
  online: Record<string, number>;
  /** True while waiting to be paired, when a filter that cannot match matters most. */
  queued: boolean;
  onClearAll: () => void;
}

const GENDER_LABEL: Record<string, string> = {
  any: "Anyone",
  male: "Men",
  female: "Women",
};

/**
 * What the search is currently restricted to, in plain sight.
 *
 * Filters are remembered between visits, which is useful right up until it is
 * not: a country picked once silently applies forever, and because the
 * matchmaker never relaxes a country filter, someone whose friends are
 * elsewhere waits in an empty queue with nothing on screen to explain it.
 * Showing the restriction next to the video — not behind a tab — is what turns
 * "it never connects" into "oh, I set that".
 */
export function ActiveFilters({ filters, online, queued, onClearAll }: Props) {
  const { countries, gender } = filters;
  const restricted = countries.length > 0 || gender !== "any";
  if (!restricted) return null;

  const reachable = countries.reduce((sum, code) => sum + (online[code] ?? 0), 0);
  // Only meaningful once the counts have actually loaded.
  const knowCounts = Object.keys(online).length > 0;
  const impossible = countries.length > 0 && knowCounts && reachable === 0;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl px-3 py-2 text-sm ${
        impossible
          ? "bg-amber-500/10 text-amber-700"
          : "bg-white text-ink-600 ring-1 ring-ink-200"
      }`}
    >
      <span className="font-medium">Searching</span>

      <span className="text-ink-500">{GENDER_LABEL[gender] ?? gender}</span>

      {countries.length > 0 && (
        <span className="min-w-0 truncate">
          in{" "}
          {countries
            .map((code) => `${countryFlag(code)} ${countryName(code)}`)
            .join(", ")}
        </span>
      )}

      {impossible && (
        <span className="w-full text-[13px] leading-snug sm:w-auto">
          {queued
            ? "Nobody from there is online, so this will not match."
            : "Nobody from there is online right now."}
        </span>
      )}

      {/*
       * Clears the gender restriction too, not just countries.
       *
       * Both are enforced in both directions and neither is ever relaxed, so
       * two people of the same gender each searching for the other gender can
       * never be paired — which is exactly what happens to two friends trying
       * to test the app together. One tap has to undo all of it.
       */}
      <button
        type="button"
        onClick={onClearAll}
        className="ml-auto min-h-11 shrink-0 rounded-lg px-2 font-medium text-brand-600 hover:text-brand-700 sm:min-h-0"
      >
        Match anyone
      </button>
    </div>
  );
}
