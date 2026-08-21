import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import api from "../lib/axios";
import { useAuthStore } from "../store/authStore";
import { Logo } from "../components/Logo";
import type { Gender } from "../lib/types";

const GENDERS: { value: Gender; label: string }[] = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "other", label: "Other" },
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
  const [countries, setCountries] = useState<string[]>([]);

  useEffect(() => {
    api
      .get<{ countries: string[] }>("/meta/countries")
      .then((res) => setCountries(Array.isArray(res.data?.countries) ? res.data.countries : []))
      .catch(() => setCountries([]));
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
    <div className="grid min-h-screen place-items-center px-5 py-10">
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
            <div className="grid grid-cols-3 gap-2">
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
            <label htmlFor="country" className={label}>
              Country
            </label>
            <select
              id="country"
              value={form.country}
              onChange={(e) => set("country")(e.target.value)}
              className={field}
            >
              <option value="">—</option>
              {countries.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
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
    </div>
  );
}
