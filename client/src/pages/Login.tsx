import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { Logo } from "../components/Logo";
import { LegalFooter } from "../components/LegalFooter";

const field =
  "w-full rounded-xl bg-ink-100 px-3.5 py-2.5 text-sm text-ink-900 " +
  "placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500";
const label = "mb-1.5 block text-sm font-medium text-ink-700";

export default function Login() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  if (token) return <Navigate to="/chat" replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await login(email, password);
      navigate("/chat");
    } catch {
      // The store holds the message.
    }
  };

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
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">Sign in</h1>

          <div>
            <label htmlFor="email" className={label}>
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
          </div>

          {error && <p className="text-sm text-danger-500">{error}</p>}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-xl bg-brand-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
          >
            {isLoading ? "Signing in" : "Sign in"}
          </button>

          <p className="text-center text-sm text-ink-500">
            <Link to="/register" className="font-medium text-brand-600 hover:text-brand-700">
              Create an account
            </Link>
          </p>
        </form>

        <LegalFooter />
      </div>
    </div>
  );
}
