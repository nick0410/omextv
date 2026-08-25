import { Link } from "react-router-dom";

/**
 * What the service is, and where the policies are.
 *
 * The root path only redirects — signed in to the app, signed out to sign in —
 * so there is no page anywhere that says what Omextv does or what it sells.
 * That is fine for someone who already knows; it is a problem for anyone
 * arriving to assess the site, which is exactly what a payment gateway's
 * activation review does before it will let you take money.
 *
 * Sat on the sign-in and sign-up pages because those are where a visitor
 * actually lands.
 */
export function LegalFooter() {
  return (
    <footer className="mx-auto mt-8 w-full max-w-sm px-4 text-center">
      <p className="text-[13px] leading-relaxed text-ink-500">
        Omextv is a random 1-to-1 video chat for adults. Matching is free. Coins are an optional
        virtual balance that unlocks choosing who you meet — a gender, or a country.
      </p>

      <nav className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[13px]">
        <Link to="/terms" className="text-ink-500 hover:text-ink-800">Terms</Link>
        <span className="text-ink-300" aria-hidden="true">·</span>
        <Link to="/privacy" className="text-ink-500 hover:text-ink-800">Privacy</Link>
        <span className="text-ink-300" aria-hidden="true">·</span>
        <Link to="/refunds" className="text-ink-500 hover:text-ink-800">Refunds</Link>
        <span className="text-ink-300" aria-hidden="true">·</span>
        <Link to="/contact" className="text-ink-500 hover:text-ink-800">Contact</Link>
      </nav>
    </footer>
  );
}
