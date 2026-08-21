import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildOptions,
  matchesQuery,
  sortOptions,
  type CountryOption,
} from "../lib/countries";

interface Props {
  open: boolean;
  codes: readonly string[];
  online: Record<string, number>;
  selected: string[];
  maxSelected?: number;
  onClose: () => void;
  onChange: (codes: string[]) => void;
}

const Check = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m5 13 4 4L19 7" />
  </svg>
);

function Row({
  option,
  checked,
  disabled,
  onToggle,
}: {
  option: CountryOption;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      disabled={disabled && !checked}
      onClick={onToggle}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-brand-50" : "hover:bg-ink-100"
      }`}
    >
      <span className="text-xl leading-none" aria-hidden="true">
        {option.flag}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink-900">
          {option.name}
        </span>
        {option.online > 0 && (
          <span className="text-xs text-ink-500">{option.online} online</span>
        )}
      </span>

      <span
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-md ${
          checked ? "bg-brand-500 text-white" : "ring-1 ring-ink-300"
        }`}
      >
        {checked && <Check />}
      </span>
    </button>
  );
}

export function CountryPicker({ open, ...rest }: Props) {
  // Mount only while open, so the panel's own state (the search query) resets
  // naturally instead of being cleared by an effect on every toggle.
  if (!open) return null;
  return <PickerPanel {...rest} />;
}

function PickerPanel({
  codes,
  online,
  selected,
  maxSelected = 10,
  onClose,
  onChange,
}: Omit<Props, "open">) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // With 249 entries, typing is the fast path.
    const id = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  // Escape closes, as any dialog should.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const options = useMemo(() => sortOptions(buildOptions(codes, online)), [codes, online]);
  const visible = useMemo(
    () => options.filter((option) => matchesQuery(option, query)),
    [options, query],
  );

  const selectedSet = new Set(selected);
  const atLimit = selected.length >= maxSelected;

  const toggle = (code: string) => {
    onChange(
      selectedSet.has(code)
        ? selected.filter((c) => c !== code)
        : [...selected, code].slice(0, maxSelected),
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Choose countries"
      onClick={(event) => {
        // Only a click on the backdrop itself closes, not one that bubbled
        // up from inside the panel.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-[440px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_8px_40px_rgba(15,23,42,0.16)]">
        <div className="border-b border-ink-200 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">
              Countries
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-8 w-8 place-items-center rounded-lg text-ink-500 hover:bg-ink-100"
            >
              ✕
            </button>
          </div>

          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search countries"
            className="w-full rounded-xl bg-ink-100 px-3.5 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          />

          <p className="mt-2 text-xs text-ink-500">
            {selected.length === 0
              ? "Anywhere"
              : `${selected.length} of ${maxSelected} selected`}
          </p>
        </div>

        <div role="listbox" aria-multiselectable className="flex-1 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-400">No matches</p>
          ) : (
            visible.map((option) => (
              <Row
                key={option.code}
                option={option}
                checked={selectedSet.has(option.code)}
                disabled={atLimit}
                onToggle={() => toggle(option.code)}
              />
            ))
          )}
        </div>

        <div className="flex gap-2 border-t border-ink-200 p-4">
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={selected.length === 0}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-ink-500 hover:text-ink-900 disabled:opacity-40"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl bg-brand-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-600"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
