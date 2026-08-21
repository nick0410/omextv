import { stores } from "../store";
import { QueueEntry, MatchResult } from "../../types";
import { selectPartner, buildMatchResult } from "./engine";

/**
 * Store-backed matchmaking.
 *
 * The in-process `MatchmakingEngine` remains the reference implementation and
 * is what the bulk of the matching tests exercise. This layer runs the same
 * decision function (`selectPartner`) against whichever store is configured,
 * so behaviour does not change when Redis is switched on.
 *
 * The atomicity guarantee is preserved by `queue.withLock`: in memory it is a
 * no-op because the runtime is already single-threaded, on Redis it is a real
 * distributed lock. Either way exactly one matcher runs at a time, so nobody
 * is handed two partners.
 */

export async function joinQueue(
  entry: QueueEntry,
  now: number = Date.now(),
): Promise<MatchResult | null> {
  const store = stores();

  const result = await store.queue.withLock(async () => {
    // A re-join must not leave a stale copy behind.
    await store.queue.remove(entry.userId);

    const lanes = await store.queue.snapshot();
    const partner = selectPartner(entry, lanes, now);

    if (!partner) {
      await store.queue.enqueue(entry);
      return null;
    }

    await store.queue.remove(partner.userId);
    return buildMatchResult(entry, partner, now);
  });

  // A null return means the lock was held elsewhere — the caller is not
  // queued, so put them in and let the sweep pick them up rather than
  // dropping them silently.
  if (result === null && !(await store.queue.has(entry.userId))) {
    await store.queue.enqueue(entry);
  }

  return result;
}

export async function leaveQueue(userId: string): Promise<QueueEntry | null> {
  return stores().queue.remove(userId);
}

export async function isQueued(userId: string): Promise<boolean> {
  return stores().queue.has(userId);
}

export async function queuePosition(userId: string): Promise<number> {
  return stores().queue.positionOf(userId);
}

export async function queueSize(): Promise<number> {
  return stores().queue.size();
}

/**
 * Re-evaluate everyone waiting.
 *
 * This is what makes the relaxation ladder actually fire: without a periodic
 * sweep, crossing a stage threshold would never trigger a re-check because
 * nothing re-examines a waiting user until a new arrival happens to scan past.
 */
export async function sweep(now: number = Date.now()): Promise<MatchResult[]> {
  const store = stores();

  const results = await store.queue.withLock(async () => {
    const lanes = await store.queue.snapshot();
    const waiting = [...lanes.premium, ...lanes.standard];
    const matched: MatchResult[] = [];
    const claimed = new Set<string>();

    for (const seeker of waiting) {
      if (claimed.has(seeker.userId)) continue;

      // Exclude anyone already paired earlier in this same sweep.
      const remaining = {
        premium: lanes.premium.filter(
          (e) => !claimed.has(e.userId) && e.userId !== seeker.userId,
        ),
        standard: lanes.standard.filter(
          (e) => !claimed.has(e.userId) && e.userId !== seeker.userId,
        ),
      };

      const partner = selectPartner(seeker, remaining, now);
      if (!partner) continue;

      claimed.add(seeker.userId);
      claimed.add(partner.userId);
      await store.queue.remove(seeker.userId);
      await store.queue.remove(partner.userId);
      matched.push(buildMatchResult(seeker, partner, now));
    }

    return matched;
  });

  return results ?? [];
}

export async function queueStats() {
  const store = stores();
  const [lanes, oldest] = await Promise.all([
    store.queue.laneSizes(),
    store.queue.oldestWaitMs(Date.now()),
  ]);
  return {
    queued: lanes.premium + lanes.standard,
    queuedPremium: lanes.premium,
    queuedStandard: lanes.standard,
    oldestWaitMs: oldest,
  };
}
