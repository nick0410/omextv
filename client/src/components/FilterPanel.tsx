import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/axios";
import { CountryPicker } from "./CountryPicker";
import { COUNTRY_CODES, countryFlag, countryName } from "../lib/countries";
import { useOnlineCountries } from "../hooks/useOnlineCountries";
import type { GenderPreference, MatchFilters } from "../lib/types";

interface Props {
  filters: MatchFilters;
  onChange: (filters: MatchFilters) => void;
  disabled: boolean;
  /** What the camera read, used only to label the suggested option. */
  suggested: GenderPreference | null;
  /** Whether choosing a gender or a country is unlocked for this account. */
  isPremium: boolean;
}

const GENDERS: { value: GenderPreference; label: string }[] = [
  { value: "any", label: "Anyone" },
  { value: "female", label: "Women" },
  { value: "male", label: "Men" },
];

/**
 * Locked, not hidden.
 *
 * Removing the controls a free account cannot use would make the app look
 * simpler and sell nothing — nobody pays for a feature they never knew was
 * there. Showing them, greyed, with one tap to the price, is the whole pitch.
 *
 * None of this is the actual restriction. The server clamps the filters when
 * the request arrives, because this panel is a suggestion and the socket
 * payload is not.
 */
function LockedHint() {
  return (
    <Link
      to="/coins"
      className="mt-2 flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-500/5 px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-500/20 hover:bg-brand-500/10"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      Unlock with coins
    </Link>
  );
}

export function FilterPanel({ filters, onChange, disabled, suggested, isPremium }: Props) {
  // Seeded from the bundled list so the picker is usable immediately and stays
  // usable if the API is unreachable.
  const [codes, setCodes] = useState<readonly string[]>(COUNTRY_CODES);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Which countries have someone online, so a filter that guarantees an empty
  // queue is visible as such rather than silently never matching.
  const online = useOnlineCountries();

  useEffect(() => {
    api
      .get<{ countries: string[] }>("/meta/countries")
      .then((res) => {
        // Only replace the bundled list with a real one. An empty or malformed
        // response must not blank out a picker that already works.
        if (Array.isArray(res.data?.countries) && res.data.countries.length > 0) {
          setCodes(res.data.countries);
        }
      })
      .catch(() => {
        /* Keep the bundled list. */
      });
  }, []);

  const setCountries = (next: string[]) => {
    // A city only means something inside exactly one country — the server drops
    // it otherwise, so mirror that rather than show a filter that won't apply.
    onChange({ ...filters, countries: next, city: next.length === 1 ? filters.city : null });
  };

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto rounded-2xl bg-white p-4 ring-1 ring-ink-200">
      <section>
        <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-ink-400">
          Show me
        </h2>
        <div className="grid grid-cols-3 gap-2">
          {GENDERS.map((option) => {
            // "Anyone" is what free accounts get, so it is never locked.
            const locked = !isPremium && option.value !== "any";
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled || locked}
                aria-disabled={locked || undefined}
                title={locked ? "Premium — unlock with coins" : undefined}
                onClick={() => onChange({ ...filters, gender: option.value })}
                className={`relative rounded-xl px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                  filters.gender === option.value
                    ? "bg-brand-500 text-white"
                    : "bg-ink-100 text-ink-700 hover:bg-ink-200"
                }`}
              >
                {option.label}
                {suggested === option.value && filters.gender !== option.value && !locked && (
                  <span
                    title="Suggested for you"
                    className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand-500"
                  />
                )}
              </button>
            );
          })}
        </div>
        {!isPremium && <LockedHint />}
      </section>

      <section>
        <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-ink-400">
          Country
        </h2>

        <button
          type="button"
          disabled={disabled || !isPremium}
          aria-disabled={!isPremium || undefined}
          title={!isPremium ? "Premium — unlock with coins" : undefined}
          onClick={() => setPickerOpen(true)}
          className="flex w-full items-center justify-between gap-3 rounded-xl bg-ink-100 px-3.5 py-2.5 text-left transition-colors hover:bg-ink-200 disabled:opacity-50"
        >
          <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
            {filters.countries.length === 0 ? (
              <span className="text-ink-500">Anywhere</span>
            ) : (
              filters.countries
                .map((code) => `${countryFlag(code)} ${countryName(code)}`)
                .join(", ")
            )}
          </span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-ink-400"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {!isPremium && <LockedHint />}
      </section>

      {isPremium && filters.countries.length === 1 && (
        <section>
          <label
            htmlFor="city"
            className="mb-2.5 block text-[13px] font-semibold uppercase tracking-wide text-ink-400"
          >
            City
          </label>
          <input
            id="city"
            value={filters.city ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...filters, city: e.target.value || null })}
            placeholder="Any city"
            className="w-full rounded-xl bg-ink-100 px-3.5 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
          />
        </section>
      )}

      <CountryPicker
        open={pickerOpen}
        codes={codes}
        online={online}
        selected={filters.countries}
        onClose={() => setPickerOpen(false)}
        onChange={setCountries}
      />
    </div>
  );
}
