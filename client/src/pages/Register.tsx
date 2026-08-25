import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import api from "../lib/axios";
import { useAuthStore } from "../store/authStore";
import { Logo } from "../components/Logo";
import { CountryPicker } from "../components/CountryPicker";
import { COUNTRY_CODES, countryFlag, countryName } from "../lib/countries";
import type { Gender } from "../lib/types";
import { LegalFooter } from "../components/LegalFooter";
import { WakingNotice } from "../components/WakingNotice";

const GENDERS: { value: Gender; label: string }[] = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
];

const field =
  "w-full rounded-xl bg-ink-100 px-3.5 py-2.5 text-sm text-ink-900 " +
  "placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500";
const label = "mb-1.5 block text-sm font-medium text-ink-700";

export default function Register() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const register = useAuthStore((s) => s.register);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);

  const [form, setForm] = useState({
    email: "",
    password: "",
    username: "",
    gender: "female" as Gender,
    country: "",
  });
  const [countries, setCountries] = useState<readonly string[]>(COUNTRY_CODES);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    api
      .get<{ countries: string[] }>("/meta/countries")
      .then((res) => {
        if (Array.isArray(res.data?.countries) && res.data.countries.length > 0) {
          setCountries(res.data.countries);
        }
      })
      .catch(() => {
        /* Keep the bundled list — registration must not be blocked by a
           country list the client already knows. */
      });
  }, []);

  if (token) return <Navigate to="/chat" replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await register({ ...form, country: form.country || undefined });
      navigate("/chat");
    } catch {
      // The store holds the message.
    }
  };

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.06),0_8px_24px_rgba(15,23,42,0.06)]"
        >
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">
            Create account
          </h1>

          <div>
            <label htmlFor="username" className={label}>
              Username
            </label>
            <input
              id="username"
              required
              minLength={3}
              maxLength={20}
              pattern="[a-zA-Z0-9_]+"
              title="Letters, numbers and underscores only"
              value={form.username}
              onChange={(e) => set("username")(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="email" className={label}>
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(e) => set("email")(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="password" className={label}>
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => set("password")(e.target.value)}
              className={field}
            />
          </div>

          <fieldset>
            <legend className={label}>Gender</legend>
            <div className="grid grid-cols-2 gap-2">
              {GENDERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => set("gender")(option.value)}
                  className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    form.gender === option.value
                      ? "bg-brand-500 text-white"
                      : "bg-ink-100 text-ink-700 hover:bg-ink-200"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <span className={label}>Country</span>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className={`${field} flex items-center justify-between gap-3 text-left`}
            >
              <span className="min-w-0 flex-1 truncate">
                {form.country ? (
                  `${countryFlag(form.country)} ${countryName(form.country)}`
                ) : (
                  <span className="text-ink-400">Select</span>
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
          </div>

          {error && <p className="text-sm text-danger-500">{error}</p>}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-xl bg-brand-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
          >
            {isLoading ? "Creating" : "Create account"}
          </button>

          <p className="text-center text-sm text-ink-500">
            <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">
              Sign in instead
            </Link>
          </p>
        </form>
      </div>

      <CountryPicker
        open={pickerOpen}
        codes={countries}
        online={{}}
        selected={form.country ? [form.country] : []}
        maxSelected={1}
        onClose={() => setPickerOpen(false)}
        onChange={(next) => set("country")(next[0] ?? "")}
      />

      <WakingNotice />
      <LegalFooter />
    </div>
  );
}
