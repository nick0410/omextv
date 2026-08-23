import { randomUUID } from "crypto";
import { FifoQueue } from "./queue";
import {
  QueueEntry,
  MatchResult,
  MatchFilters,
  Gender,
  GenderPreference,
} from "../../types";

/**
 * Relaxation ladder.
 *
 * A user who asked for women in Japan must never be handed a man in Brazil
 * because the queue was slow — so country and gender are NEVER relaxed, and
 * neither are blocks. What we do relax over time are the soft de-duplication
 * rules that only exist to keep the experience varied: how recently you talked
 * to someone, and the city sub-filter.
 */
export const RELAX_STAGES = [
  { afterMs: 0, recentPartnerWindowMs: 30 * 60_000, enforceCity: true },
  { afterMs: 20_000, recentPartnerWindowMs: 5 * 60_000, enforceCity: false },
  { afterMs: 60_000, recentPartnerWindowMs: 0, enforceCity: false },
] as const;

export function stageFor(waitedMs: number): number {
  let stage = 0;
  for (let i = 0; i < RELAX_STAGES.length; i++) {
    if (waitedMs >= RELAX_STAGES[i].afterMs) stage = i;
  }
  return stage;
}

/** Does `pref` accept a user whose effective gender is `gender`? */
export function genderAccepts(pref: GenderPreference, gender: Gender): boolean {
  return pref === "any" || pref === gender;
}

/** Does `filters` accept `candidate`, ignoring the reverse direction? */
export function filtersAccept(
  filters: MatchFilters,
  candidate: QueueEntry,
  enforceCity: boolean,
): boolean {
  if (!genderAccepts(filters.gender, candidate.effectiveGender)) return false;

  if (filters.countries.length > 0) {
    // A user with no country on file can never satisfy a country filter.
    if (!candidate.country) return false;
    if (!filters.countries.includes(candidate.country)) return false;
  }

  if (enforceCity && filters.city) {
    if (!candidate.city) return false;
    if (candidate.city.toLowerCase() !== filters.city.toLowerCase()) return false;
  }

  return true;
}

/**
 * Full two-way compatibility. `now` is passed in rather than read from the
 * clock so tests can drive time deterministically.
 */
/**
 * Say, in words, why two waiting people are not being paired.
 *
 * `isCompatible` returns a bare boolean, which is the right shape for the
 * matchmaker and useless for anyone asking "why has nobody matched me for two
 * minutes". The rules that block a pair are almost always filters the user
 * forgot they set, and they are enforced in *both* directions — so the reason
 * is frequently the other person's filter, which no amount of staring at your
 * own settings will reveal.
 *
 * Returns null when the pair is compatible.
 */
export function explainIncompatibility(
  a: QueueEntry,
  b: QueueEntry,
  stage: number,
  now: number,
): string | null {
  if (a.userId === b.userId) return "same user";

  if (a.blockedIds.has(b.userId)) return "A has blocked B";
  if (b.blockedIds.has(a.userId)) return "B has blocked A";

  const cfg = RELAX_STAGES[Math.min(stage, RELAX_STAGES.length - 1)];

  const oneWay = (
    from: QueueEntry,
    to: QueueEntry,
    fromLabel: string,
    toLabel: string,
  ): string | null => {
    if (!genderAccepts(from.filters.gender, to.effectiveGender)) {
      return `${fromLabel} is searching for "${from.filters.gender}" but ${toLabel} is ${to.effectiveGender}`;
    }
    if (from.filters.countries.length > 0) {
      if (!to.country) {
        return `${fromLabel} filters by country but ${toLabel} has no country set`;
      }
      if (!from.filters.countries.includes(to.country)) {
        return `${fromLabel} only wants ${from.filters.countries.join(", ")} but ${toLabel} is in ${to.country}`;
      }
    }
    if (cfg.enforceCity && from.filters.city) {
      if (!to.city) return `${fromLabel} filters by city but ${toLabel} has no city set`;
      if (to.city.toLowerCase() !== from.filters.city.toLowerCase()) {
        return `${fromLabel} only wants ${from.filters.city} but ${toLabel} is in ${to.city}`;
      }
    }
    return null;
  };

  const aRejects = oneWay(a, b, "A", "B");
  if (aRejects) return aRejects;
  const bRejects = oneWay(b, a, "B", "A");
  if (bRejects) return bRejects;

  if (cfg.recentPartnerWindowMs > 0) {
    const lastA = a.recentPartners.get(b.userId);
    if (lastA !== undefined && now - lastA < cfg.recentPartnerWindowMs) {
      return `they were paired ${Math.round((now - lastA) / 1000)}s ago; the rematch window is ${Math.round(cfg.recentPartnerWindowMs / 1000)}s`;
    }
    const lastB = b.recentPartners.get(a.userId);
    if (lastB !== undefined && now - lastB < cfg.recentPartnerWindowMs) {
      return `they were paired ${Math.round((now - lastB) / 1000)}s ago; the rematch window is ${Math.round(cfg.recentPartnerWindowMs / 1000)}s`;
    }
  }

  return isCompatible(a, b, stage, now) ? null : "blocked by a rule not covered here";
}

export function isCompatible(
  a: QueueEntry,
  b: QueueEntry,
  stage: number,
  now: number,
): boolean {
  if (a.userId === b.userId) return false;

  // --- Hard rules, never relaxed ---
  if (a.blockedIds.has(b.userId)) return false;
  if (b.blockedIds.has(a.userId)) return false;

  const cfg = RELAX_STAGES[Math.min(stage, RELAX_STAGES.length - 1)];

  // --- Filters, both directions ---
  if (!filtersAccept(a.filters, b, cfg.enforceCity)) return false;
  if (!filtersAccept(b.filters, a, cfg.enforceCity)) return false;

  // --- Recent-partner avoidance (soft, relaxes with stage) ---
  if (cfg.recentPartnerWindowMs > 0) {
    const lastA = a.recentPartners.get(b.userId);
    if (lastA !== undefined && now - lastA < cfg.recentPartnerWindowMs) return false;
    const lastB = b.recentPartners.get(a.userId);
    if (lastB !== undefined && now - lastB < cfg.recentPartnerWindowMs) return false;
  }

  return true;
}

/**
 * Pick a partner for `seeker` out of an already-materialised snapshot.
 *
 * This is the store-agnostic half of matching: the caller supplies the two
 * lanes (from memory or from Redis) and this decides who wins, using the same
 * compatibility rules as the in-process engine.
 *
 * Premium lane first so paying users wait less; within a lane the array is
 * oldest-first, so the longest compatible waiter always wins.
 *
 * The stage used is the more generous of the two waits — otherwise a
 * long-waiting user stays stuck behind a stream of strict newcomers.
 */
export function selectPartner(
  seeker: QueueEntry,
  lanes: { premium: QueueEntry[]; standard: QueueEntry[] },
  now: number,
): QueueEntry | null {
  const seekerStage = stageFor(now - seeker.joinedAt);

  for (const lane of [lanes.premium, lanes.standard]) {
    for (const candidate of lane) {
      if (candidate.userId === seeker.userId) continue;
      const stage = Math.max(seekerStage, stageFor(now - candidate.joinedAt));
      if (isCompatible(seeker, candidate, stage, now)) return candidate;
    }
  }
  return null;
}

/** Build the result payload for a pair chosen by `selectPartner`. */
export function buildMatchResult(
  a: QueueEntry,
  b: QueueEntry,
  now: number,
): MatchResult {
  const stage = Math.max(stageFor(now - a.joinedAt), stageFor(now - b.joinedAt));
  a.relaxStage = stage;
  b.relaxStage = stage;
  return {
    roomId: randomUUID(),
    a,
    b,
    stage,
    matchedOn: {
      aFilters: a.filters,
      bFilters: b.filters,
      aWaitedMs: now - a.joinedAt,
      bWaitedMs: now - b.joinedAt,
    },
  };
}

/**
 * The matchmaker.
 *
 * Two FIFO lanes. Premium waiters are scanned before standard ones, so paying
 * users wait less — but *within* a lane the oldest compatible waiter always
 * wins, which is the FIFO guarantee. A newcomer can never jump ahead of
 * someone who has been waiting longer and is equally compatible.
 *
 * Every public method is synchronous. On a single-threaded runtime that makes
 * each call atomic: it is impossible for two concurrent joinQueue calls to
 * interleave and hand the same partner to both, which is exactly the bug the
 * previous async findMatch had.
 */
export class MatchmakingEngine {
  private premium = new FifoQueue<QueueEntry>((e) => e.userId);
  private standard = new FifoQueue<QueueEntry>((e) => e.userId);
  /** Guards against reentrancy if a listener ever calls back in synchronously. */
  private matching = false;

  get size(): number {
    return this.premium.size + this.standard.size;
  }

  get premiumSize(): number {
    return this.premium.size;
  }

  get standardSize(): number {
    return this.standard.size;
  }

  has(userId: string): boolean {
    return this.premium.has(userId) || this.standard.has(userId);
  }

  get(userId: string): QueueEntry | null {
    return this.premium.get(userId) ?? this.standard.get(userId);
  }

  private laneFor(entry: QueueEntry): FifoQueue<QueueEntry> {
    return entry.isPremium ? this.premium : this.standard;
  }

  /**
   * Try to pair `entry` with someone already waiting. On success neither user
   * is left in the queue. On failure `entry` is enqueued and null is returned.
   */
  joinQueue(entry: QueueEntry, now: number = Date.now()): MatchResult | null {
    if (this.matching) {
      throw new Error("MatchmakingEngine: reentrant joinQueue");
    }
    this.matching = true;
    try {
      // A rejoin must not leave a stale copy behind in the other lane.
      this.removeInternal(entry.userId);

      const partner = this.findPartnerFor(entry, now);
      if (partner) {
        return this.buildResult(entry, partner, now);
      }

      this.laneFor(entry).enqueue(entry);
      return null;
    } finally {
      this.matching = false;
    }
  }

  /** Remove a user from whichever lane holds them. */
  leaveQueue(userId: string): QueueEntry | null {
    return this.removeInternal(userId);
  }

  private removeInternal(userId: string): QueueEntry | null {
    return this.premium.remove(userId) ?? this.standard.remove(userId);
  }

  /**
   * Scan the lanes for someone compatible with `seeker`.
   *
   * The stage used is the *more generous* of the two waits: if the seeker just
   * arrived but the candidate has been waiting two minutes, the candidate
   * relaxations apply. Otherwise a long-waiting user would stay stuck behind
   * a stream of strict newcomers.
   */
  private findPartnerFor(seeker: QueueEntry, now: number): QueueEntry | null {
    const seekerStage = stageFor(now - seeker.joinedAt);

    const predicate = (candidate: QueueEntry): boolean => {
      if (candidate.userId === seeker.userId) return false;
      const candidateStage = stageFor(now - candidate.joinedAt);
      const stage = Math.max(seekerStage, candidateStage);
      return isCompatible(seeker, candidate, stage, now);
    };

    return this.premium.takeFirst(predicate) ?? this.standard.takeFirst(predicate);
  }

  private buildResult(a: QueueEntry, b: QueueEntry, now: number): MatchResult {
    const stage = Math.max(stageFor(now - a.joinedAt), stageFor(now - b.joinedAt));
    a.relaxStage = stage;
    b.relaxStage = stage;
    return {
      roomId: randomUUID(),
      a,
      b,
      stage,
      matchedOn: {
        aFilters: a.filters,
        bFilters: b.filters,
        aWaitedMs: now - a.joinedAt,
        bWaitedMs: now - b.joinedAt,
      },
    };
  }

  /**
   * Re-attempt matches for everyone currently waiting.
   *
   * This is what makes relaxation actually fire: without a periodic sweep, a
   * user who crosses the 60s threshold would sit there forever because nothing
   * re-evaluates them until a new arrival happens to scan past.
   *
   * Oldest-first, so the longest waiters are served first.
   */
  sweep(now: number = Date.now()): MatchResult[] {
    if (this.matching) return [];
    this.matching = true;
    try {
      const results: MatchResult[] = [];
      // Snapshot: pairing mutates both lanes underneath us.
      const waiting = [...this.premium.toArray(), ...this.standard.toArray()];

      for (const seeker of waiting) {
        // Already claimed as someone else's partner earlier in this sweep.
        if (!this.has(seeker.userId)) continue;

        const partner = this.findPartnerForExcluding(seeker, now);
        if (partner) {
          this.removeInternal(seeker.userId);
          results.push(this.buildResult(seeker, partner, now));
        }
      }
      return results;
    } finally {
      this.matching = false;
    }
  }

  private findPartnerForExcluding(seeker: QueueEntry, now: number): QueueEntry | null {
    const seekerStage = stageFor(now - seeker.joinedAt);
    const predicate = (candidate: QueueEntry): boolean => {
      if (candidate.userId === seeker.userId) return false;
      const stage = Math.max(seekerStage, stageFor(now - candidate.joinedAt));
      return isCompatible(seeker, candidate, stage, now);
    };
    return this.premium.takeFirst(predicate) ?? this.standard.takeFirst(predicate);
  }

  /** 1-based queue position for display, or -1 if not queued. */
  positionOf(userId: string): number {
    const inPremium = this.premium.positionOf(userId);
    if (inPremium >= 0) return inPremium + 1;
    const inStandard = this.standard.positionOf(userId);
    if (inStandard >= 0) return this.premium.size + inStandard + 1;
    return -1;
  }

  /** How long the oldest waiter has been queued — a starvation alarm. */
  oldestWaitMs(now: number = Date.now()): number {
    let oldest = 0;
    const check = (e: QueueEntry) => {
      const waited = now - e.joinedAt;
      if (waited > oldest) oldest = waited;
    };
    this.premium.scan(check);
    this.standard.scan(check);
    return oldest;
  }

  snapshot(): { premium: QueueEntry[]; standard: QueueEntry[] } {
    return { premium: this.premium.toArray(), standard: this.standard.toArray() };
  }

  clear(): void {
    this.premium.clear();
    this.standard.clear();
    this.matching = false;
  }
}

export const matchmakingEngine = new MatchmakingEngine();
