import { useCallback, useEffect, useState } from "react";
import api from "../lib/axios";
import { useAuthStore } from "../store/authStore";
import type { Wallet } from "../lib/types";

/**
 * The balance and what it can buy, straight from the server.
 *
 * Nothing here is cached across mounts and nothing is derived locally. A
 * balance is the one number a user will notice being wrong, and a stale copy
 * shown after a purchase reads as the payment having failed — so it is always
 * refetched, and `refresh` is exposed for the moments right after something
 * changed it.
 *
 * The catalogue rides along with the balance for the same reason prices live
 * in one file on the server: a client that knows what a pack costs is a second
 * price list waiting to disagree with the first.
 */
export function useWallet() {
  const token = useAuthStore((s) => s.token);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) {
      setWallet(null);
      setLoading(false);
      return;
    }
    try {
      const res = await api.get<Wallet>("/coins/me");
      setWallet(res.data);
      setError(null);
    } catch {
      setError("Could not load your balance.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { wallet, loading, error, refresh, setWallet };
}

/**
 * Is premium actually in force right now?
 *
 * The stored flag and the expiry disagree the moment a pass lapses, and the
 * flag is the one that lies. Anything deciding whether to show a lock has to
 * ask this rather than read `isPremium`.
 */
export function premiumIsActive(user: {
  isPremium?: boolean;
  premiumExpiry?: string | null;
} | null): boolean {
  if (!user?.isPremium) return false;
  if (!user.premiumExpiry) return true;
  return new Date(user.premiumExpiry).getTime() > Date.now();
}
