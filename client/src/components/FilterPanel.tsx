import { useEffect, useState } from "react";
import api from "../lib/axios";
import type { GenderPreference, MatchFilters } from "../lib/types";

interface Props {
  filters: MatchFilters;
  onChange: (filters: MatchFilters) => void;
  disabled: boolean;
}

const GENDERS: { value: GenderPreference; label: string }[] = [
  { value: "any", label: "Anyone" },
  { value: "female", label: "Women" },
  { value: "male", label: "Men" },
  { value: "other", label: "Other" },
];

export function FilterPanel({ filters, onChange, disabled }: Props) {
  const [countries, setCountries] = useState<string[]>([]);
  const [online, setOnline] = useState<Record<string, number>>({});

  useEffect(() => {
    api
      .get<{ countries: string[] }>("/meta/countries")
      .then((res) => setCountries(Array.isArray(res.data?.countries) ? res.data.countries : []))
      .catch(() => setCountries([]));
  }, []);

  // Which countries have someone online, so a filter that guarantees an empty
  // queue is visibly greyed rather than silently never matching.
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

  const toggleCountry = (code: string) => {
    const selected = filters.countries.includes(code)
      ? filters.countries.filter((c) => c !== code)
      : [...filters.countries, code].slice(0, 10);
    // A city only means something inside exactly one country — the server drops
    // it otherwise, so mirror that rather than show a filter that won't apply.
    onChange({
      ...filters,
      countries: selected,
      city: selected.length === 1 ? filters.city : null,
    });
  };

  const selected = new Set(filters.countries);
  const ordered = [...countries].sort((a, b) => {
    const diff = (online[b] ?? 0) - (online[a] ?? 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto rounded-2xl bg-white p-4 ring-1 ring-ink-200">
      <section>
        <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-ink-400">
          Gender
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {GENDERS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...filters, gender: option.value })}
              className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                filters.gender === option.value
                  ? "bg-brand-500 text-white"
                  : "bg-ink-100 text-ink-700 hover:bg-ink-200"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-400">
            Country
          </h2>
          {filters.countries.length > 0 && (
            <button
              type="button"
              onClick={() => onChange({ ...filters, countries: [], city: null })}
              className="text-[13px] font-medium text-brand-600 hover:text-brand-700"
            >
              Clear
            </button>
          )}
        </div>

        <div className="max-h-52 overflow-y-auto rounded-xl bg-ink-100 p-2">
          <div className="flex flex-wrap gap-1.5">
            {ordered.map((code) => {
              const count = online[code] ?? 0;
              return (
                <button
                  key={code}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleCountry(code)}
                  className={`rounded-lg px-2 py-1 text-xs font-medium tabular transition-colors disabled:opacity-50 ${
                    selected.has(code)
                      ? "bg-brand-500 text-white"
                      : count > 0
                        ? "bg-white text-ink-700 ring-1 ring-ink-200 hover:bg-brand-50"
                        : "bg-white/60 text-ink-400"
                  }`}
                >
                  {code}
                  {count > 0 && <span className="ml-1 opacity-70">{count}</span>}
                </button>
              );
            })}
          </div>
        </div>
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
            className="w-full rounded-xl bg-ink-100 px-3.5 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:bg-white focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
          />
        </section>
      )}
    </div>
  );
}
