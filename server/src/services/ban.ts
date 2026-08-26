import { prisma } from "../config/database";

/**
 * Whether an account is currently shut out, in one place.
 *
 * The socket refused a banned account and the HTTP side did not, so a ban
 * stopped somebody making calls and left them free to sign in, buy coins,
 * report other people and change their profile. A ban that only closes one
 * door is not a ban.
 *
 * The expiry half is the reason this is shared rather than repeated: a ban
 * with a date on it has to stop by itself, and a second copy of that rule is
 * a second chance to get it wrong.
 */

export interface BannableUser {
  isBanned: boolean;
  bannedUntil: Date | null;
}

/** What the fields on an account mean right now. */
export function banStatus(user: BannableUser, now: number = Date.now()): "active" | "expired" | "none" {
  if (!user.isBanned) return "none";
  // No date means indefinite; a date in the future means still serving it.
  if (!user.bannedUntil || user.bannedUntil.getTime() > now) return "active";
  return "expired";
}

/** Let a served ban lapse, so the account stops being refused. */
export async function clearExpiredBan(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { isBanned: false, bannedUntil: null },
  });
}

/**
 * The whole decision for one account, including letting a served ban lapse.
 *
 * Returns true when the account should be refused. Callers that have already
 * loaded the row should use `banStatus` instead of paying for another query.
 */
export async function isShutOut(userId: string, now: number = Date.now()): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isBanned: true, bannedUntil: true },
  });
  if (!user) return true; // an account that no longer exists cannot be let in

  const status = banStatus(user, now);
  if (status === "none") return false;
  if (status === "active") return true;

  await clearExpiredBan(userId);
  return false;
}
