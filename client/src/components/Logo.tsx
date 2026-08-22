import { Link } from "react-router-dom";

export function Logo({ to = "/" }: { to?: string }) {
  return (
    <Link to={to} className="flex min-h-11 items-center gap-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-brand-500">
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="6" width="13" height="12" rx="2.5" />
          <path d="m15 11 7-4v10l-7-4z" />
        </svg>
      </span>
      <span className="text-[17px] font-semibold tracking-tight text-ink-900">Omextv</span>
    </Link>
  );
}
