import { useEffect, useState } from "react";
import { onServerWaking } from "../lib/axios";

/**
 * Says why nothing is happening yet.
 *
 * The API runs on a plan that stops the instance after fifteen idle minutes.
 * The next person to arrive waits about a minute while it starts, and without
 * this that minute looks exactly like a broken site — so they leave, and the
 * one thing this app needs is two people arriving at once.
 *
 * Only appears once a request has already been slow for two seconds, so a
 * warm server never shows it.
 */
export function WakingNotice() {
  const [waking, setWaking] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => onServerWaking(setWaking), []);

  useEffect(() => {
    if (!waking) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      setSeconds(Math.round((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [waking]);

  if (!waking) return null;

  return (
    <div
      role="status"
      className="mx-auto mt-4 flex w-full max-w-sm items-center gap-3 rounded-xl bg-brand-500/5 px-3.5 py-3 text-sm text-brand-800 ring-1 ring-brand-500/20"
    >
      <div className="spinner h-4 w-4 shrink-0 rounded-full border-2 border-brand-500/25 border-t-brand-600" />
      <p className="leading-snug">
        Waking the server up. This takes about a minute the first time, then it
        is quick.
        {/* The count is what turns "is it stuck?" into "it is working". */}
        {seconds > 4 && <span className="text-brand-700/70"> ({seconds}s)</span>}
      </p>
    </div>
  );
}
