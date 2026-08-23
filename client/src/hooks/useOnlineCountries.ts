import { useEffect, useState } from "react";
import api from "../lib/axios";

/**
 * How many people are online in each country, refreshed periodically.
 *
 * Used to warn before a filter is applied that would guarantee an empty queue.
 * A country filter is never relaxed by the matchmaker — that is deliberate,
 * since someone asking for one country does not want another — so picking a
 * country nobody is in means waiting forever with nothing on screen to say why.
 */
export function useOnlineCountries(intervalMs = 15_000): Record<string, number> {
  const [online, setOnline] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;

    const load = () =>
      api
        .get<{ countries: { country: string; online: number }[] }>("/meta/countries/online")
        .then((res) => {
          if (cancelled) return;
          const rows = Array.isArray(res.data?.countries) ? res.data.countries : [];
          const map: Record<string, number> = {};
          for (const row of rows) map[row.country] = row.online;
          setOnline(map);
        })
        .catch(() => {
          // Leave the last known counts in place; a failed poll is not news.
        });

    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return online;
}
