import { prisma } from "../config/database";
import { env } from "../config/env";
import { EndReason } from "../types";

export interface ActivePair {
  roomId: string;
  userAId: string;
  userBId: string;
  startedAt: number;
  /** ChatSession.id, once the row is written. */
  dbId: string | null;
  messageCount: number;
  lastActivityAt: number;
}

/**
 * Tracks who is talking to whom, and remembers who you have already met.
 *
 * State is deliberately keyed by userId rather than socketId: a user may
 * reconnect on a new socket mid-chat and should land back in the same pair.
 */
export class PairingRegistry {
  private byUser = new Map<string, ActivePair>();
  private byRoom = new Map<string, ActivePair>();
  /** userId -> (partnerId -> last chat epoch ms). Bounded per user. */
  private recent = new Map<string, Map<string, number>>();

  get activeCount(): number {
    return this.byRoom.size;
  }

  get pairedUserCount(): number {
    return this.byUser.size;
  }

  pairOf(userId: string): ActivePair | null {
    return this.byUser.get(userId) ?? null;
  }

  pairByRoom(roomId: string): ActivePair | null {
    return this.byRoom.get(roomId) ?? null;
  }

  partnerOf(userId: string): string | null {
    const pair = this.byUser.get(userId);
    if (!pair) return null;
    return pair.userAId === userId ? pair.userBId : pair.userAId;
  }

  isPaired(userId: string): boolean {
    return this.byUser.has(userId);
  }

  /** Is this user actually a participant in this room? */
  isMember(userId: string, roomId: string): boolean {
    const pair = this.byRoom.get(roomId);
    if (!pair) return false;
    return pair.userAId === userId || pair.userBId === userId;
  }

  /**
   * Record a new pairing in memory. Both users are marked as met immediately,
   * so a skip-and-requeue cannot instantly rematch the same two people.
   */
  create(roomId: string, userAId: string, userBId: string, now: number = Date.now()): ActivePair {
    // Defensive: never let a stale pair linger if either side was mid-chat.
    this.removeUser(userAId);
    this.removeUser(userBId);

    const pair: ActivePair = {
      roomId,
      userAId,
      userBId,
      startedAt: now,
      dbId: null,
      messageCount: 0,
      lastActivityAt: now,
    };

    this.byUser.set(userAId, pair);
    this.byUser.set(userBId, pair);
    this.byRoom.set(roomId, pair);

    this.rememberPartner(userAId, userBId, now);
    this.rememberPartner(userBId, userAId, now);

    return pair;
  }

  /** Tear down a pair. Returns it, or null if it was already gone. */
  end(roomId: string): ActivePair | null {
    const pair = this.byRoom.get(roomId);
    if (!pair) return null;
    this.byRoom.delete(roomId);
    this.byUser.delete(pair.userAId);
    this.byUser.delete(pair.userBId);
    return pair;
  }

  /** Tear down whichever pair a user is in. */
  endForUser(userId: string): ActivePair | null {
    const pair = this.byUser.get(userId);
    if (!pair) return null;
    return this.end(pair.roomId);
  }

  private removeUser(userId: string): void {
    const pair = this.byUser.get(userId);
    if (pair) this.end(pair.roomId);
  }

  noteMessage(roomId: string, now: number = Date.now()): void {
    const pair = this.byRoom.get(roomId);
    if (pair) {
      pair.messageCount++;
      pair.lastActivityAt = now;
    }
  }

  touch(roomId: string, now: number = Date.now()): void {
    const pair = this.byRoom.get(roomId);
    if (pair) pair.lastActivityAt = now;
  }

  // --- Recent partners -----------------------------------------------------

  rememberPartner(userId: string, partnerId: string, now: number = Date.now()): void {
    let map = this.recent.get(userId);
    if (!map) {
      map = new Map();
      this.recent.set(userId, map);
    }
    // Re-insert so iteration order stays least-recent-first for eviction.
    map.delete(partnerId);
    map.set(partnerId, now);

    while (map.size > env.RECENT_PARTNER_LIMIT) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  /** A copy, so the queue entry cannot be mutated from under the matcher. */
  recentPartnersOf(userId: string): Map<string, number> {
    const map = this.recent.get(userId);
    return map ? new Map(map) : new Map();
  }

  forgetUser(userId: string): void {
    this.recent.delete(userId);
  }

  /** Drop recent-partner entries older than `maxAgeMs`. */
  sweepRecent(maxAgeMs: number, now: number = Date.now()): number {
    let dropped = 0;
    for (const [userId, map] of this.recent) {
      for (const [partnerId, ts] of map) {
        if (now - ts > maxAgeMs) {
          map.delete(partnerId);
          dropped++;
        }
      }
      if (map.size === 0) this.recent.delete(userId);
    }
    return dropped;
  }

  /** Pairs with no traffic for `idleMs`. Used by the reaper. */
  findIdle(idleMs: number, now: number = Date.now()): ActivePair[] {
    const out: ActivePair[] = [];
    for (const pair of this.byRoom.values()) {
      if (now - pair.lastActivityAt >= idleMs) out.push(pair);
    }
    return out;
  }

  allPairs(): ActivePair[] {
    return [...this.byRoom.values()];
  }

  clear(): void {
    this.byUser.clear();
    this.byRoom.clear();
    this.recent.clear();
  }
}

export const pairing = new PairingRegistry();

// --- Persistence -----------------------------------------------------------
//
// Chat history is written best-effort: a database hiccup must never break a
// live call, so every helper below swallows its error after logging.

export async function persistSessionStart(
  pair: ActivePair,
  matchedOn: unknown,
): Promise<string | null> {
  try {
    const row = await prisma.chatSession.create({
      data: {
        roomId: pair.roomId,
        userAId: pair.userAId,
        userBId: pair.userBId,
        startedAt: new Date(pair.startedAt),
        matchedOn: JSON.stringify(matchedOn),
      },
      select: { id: true },
    });
    pair.dbId = row.id;
    return row.id;
  } catch (err) {
    console.error("[pairing] failed to persist session start:", err);
    return null;
  }
}

export async function persistSessionEnd(
  pair: ActivePair,
  reason: EndReason,
  endedById: string | null,
  now: number = Date.now(),
): Promise<void> {
  if (!pair.dbId) return;
  try {
    await prisma.chatSession.update({
      where: { id: pair.dbId },
      data: {
        endedAt: new Date(now),
        durationMs: now - pair.startedAt,
        endReason: reason,
        endedById,
        messageCount: pair.messageCount,
      },
    });
  } catch (err) {
    console.error("[pairing] failed to persist session end:", err);
  }
}

/**
 * Load the block list for a user, in both directions.
 *
 * Blocking is symmetric in effect: if A blocks B, neither should ever see the
 * other again, so B's queue entry has to know about it too.
 */
export async function loadBlockedIds(userId: string): Promise<Set<string>> {
  try {
    const rows = await prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(row.blockerId === userId ? row.blockedId : row.blockerId);
    }
    return ids;
  } catch (err) {
    console.error("[pairing] failed to load blocks:", err);
    // Fail closed would empty the queue; fail open and rely on the in-memory
    // recent-partner list for this session.
    return new Set();
  }
}

/**
 * Warm the in-memory recent-partner cache from history after a restart, so a
 * redeploy does not immediately rematch everyone with who they just left.
 */
export async function loadRecentPartners(
  userId: string,
  windowMs: number,
  now: number = Date.now(),
): Promise<Map<string, number>> {
  const cached = pairing.recentPartnersOf(userId);
  if (cached.size > 0) return cached;

  try {
    const since = new Date(now - windowMs);
    const rows = await prisma.chatSession.findMany({
      where: {
        startedAt: { gte: since },
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      select: { userAId: true, userBId: true, startedAt: true },
      orderBy: { startedAt: "desc" },
      take: env.RECENT_PARTNER_LIMIT,
    });

    const map = new Map<string, number>();
    for (const row of rows) {
      const partnerId = row.userAId === userId ? row.userBId : row.userAId;
      if (!map.has(partnerId)) map.set(partnerId, row.startedAt.getTime());
    }
    return map;
  } catch (err) {
    console.error("[pairing] failed to load recent partners:", err);
    return new Map();
  }
}
