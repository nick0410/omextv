import { QueueEntry, MatchFilters, Gender, InferredGender } from "../../types";

/**
 * QueueEntry carries a Set and a Map, neither of which survives JSON.
 * `JSON.stringify(new Set([1]))` yields `{}` — silently, so a round-trip
 * through Redis would quietly drop every block and every recent partner and
 * the matcher would start pairing people who blocked each other.
 */

interface SerializedEntry {
  u: string; // userId
  s: string; // socketId
  n: string; // username
  g: Gender;
  vg: InferredGender | null;
  eg: Gender;
  gv: boolean;
  c: string | null; // country
  ct: string | null; // city
  p: boolean; // isPremium
  f: MatchFilters;
  b: string[]; // blockedIds
  r: [string, number][]; // recentPartners
  j: number; // joinedAt
  rs: number; // relaxStage
}

export function serializeEntry(entry: QueueEntry): string {
  const payload: SerializedEntry = {
    u: entry.userId,
    s: entry.socketId,
    n: entry.username,
    g: entry.gender,
    vg: entry.verifiedGender,
    eg: entry.effectiveGender,
    gv: entry.genderIsVerified,
    c: entry.country,
    ct: entry.city,
    p: entry.isPremium,
    f: entry.filters,
    b: [...entry.blockedIds],
    r: [...entry.recentPartners],
    j: entry.joinedAt,
    rs: entry.relaxStage,
  };
  return JSON.stringify(payload);
}

export function deserializeEntry(raw: string | null): QueueEntry | null {
  if (!raw) return null;

  let parsed: SerializedEntry;
  try {
    parsed = JSON.parse(raw) as SerializedEntry;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.u !== "string") return null;

  return {
    userId: parsed.u,
    socketId: parsed.s,
    username: parsed.n,
    gender: parsed.g,
    verifiedGender: parsed.vg,
    effectiveGender: parsed.eg,
    genderIsVerified: parsed.gv,
    country: parsed.c,
    city: parsed.ct,
    isPremium: parsed.p,
    filters: parsed.f,
    blockedIds: new Set(Array.isArray(parsed.b) ? parsed.b : []),
    recentPartners: new Map(Array.isArray(parsed.r) ? parsed.r : []),
    joinedAt: parsed.j,
    relaxStage: parsed.rs ?? 0,
  };
}
