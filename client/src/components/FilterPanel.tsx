import { useEffect, useState } from "react";
import api from "../lib/axios";
import { CountryPicker } from "./CountryPicker";
import { countryFlag, countryName } from "../lib/countries";
import type { GenderPreference, MatchFilters } from "../lib/types";

interface Props {
  filters: MatchFilters;
  onChange: (filters: MatchFilters) => void;
  disabled: boolean;
  /** What the camera read, used only to label the suggested option. */
  suggested: GenderPreference | null;
}

const GENDERS: { value: GenderPreference; label: string }[] = [
  { value: "any", label: "Anyone" },
  { value: "female", label: "Women" },
  { value: "male", label: "Men" },
];

export function FilterPanel({ filters, onChange, disabled, suggested }: Props) {
  const [codes, setCodes] = useState<string[]>([]);
  const [online, setOnline] = useState<Record<string, number>>({});
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    api
      .get<{ countries: string[] }>("/meta/countries")
      .then((res) => setCodes(Array.isArray(res.data?.countries) ? res.data.countries : []))
      .catch(() => setCodes([]));
  }, []);

  // Which countries have someone online, so a filter that guarantees an empty
  // queue is visible as such rather than silently never matching.
  useEffect(() => {
    const load = () =>
      api
        .get<{ countries: { country: string; online: number }[] }>("/meta/countries/online")
        .then((res) => {
          const rows = Array.isArray(res.data?.countries) ? res.data.countries : [];
          const map: Record<string, number> = {};
          for (const row of rows) map[row.country] = row.online;
          setOnline(map);
        })
        .catch(() => setOnline({}));
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
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
          {GENDERS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...filters, gender: option.value })}
              className={`relative rounded-xl px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                filters.gender === option.value
                  ? "bg-brand-500 text-white"
                  : "bg-ink-100 text-ink-700 hover:bg-ink-200"
              }`}
            >
              {option.label}
              {suggested === option.value && filters.gender !== option.value && (
                <span
                  title="Suggested for you"
                  className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand-500"
                />
              )}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-ink-400">
          Country
        </h2>

        <button
          type="button"
          disabled={disabled}
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
      </section>

      {filters.countries.length === 1 && (
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
