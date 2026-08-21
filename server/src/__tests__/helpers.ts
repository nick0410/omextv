import { QueueEntry, MatchFilters, Gender, DEFAULT_FILTERS } from "../types";

let seq = 0;

export interface EntryOverrides {
  userId?: string;
  gender?: Gender;
  effectiveGender?: Gender;
  genderIsVerified?: boolean;
  country?: string | null;
  city?: string | null;
  isPremium?: boolean;
  filters?: Partial<MatchFilters>;
  blocked?: string[];
  recent?: Record<string, number>;
  joinedAt?: number;
}

/** Build a queue entry with sane defaults; every field is overridable. */
export function makeEntry(overrides: EntryOverrides = {}): QueueEntry {
  const id = overrides.userId ?? `u${++seq}`;
  const gender = overrides.gender ?? "male";

  return {
    userId: id,
    socketId: `s-${id}`,
    username: id,
    gender,
    verifiedGender: null,
    effectiveGender: overrides.effectiveGender ?? gender,
    genderIsVerified: overrides.genderIsVerified ?? false,
    country: overrides.country === undefined ? "US" : overrides.country,
    city: overrides.city === undefined ? null : overrides.city,
    isPremium: overrides.isPremium ?? false,
    filters: { ...DEFAULT_FILTERS, ...overrides.filters },
    blockedIds: new Set(overrides.blocked ?? []),
    recentPartners: new Map(Object.entries(overrides.recent ?? {})),
    joinedAt: overrides.joinedAt ?? 0,
    relaxStage: 0,
  };
}

export function resetSeq(): void {
  seq = 0;
}

/** A minimal but structurally valid JPEG (SOI + APP0 + EOI). */
export function fakeJpeg(salt = 0): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, salt & 0xff, 0xff, 0xd9,
  ]);
}

/** A minimal but structurally valid PNG signature block. */
export function fakePng(salt = 0): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, salt & 0xff,
  ]);
}

export function toDataUrl(buf: Buffer, mime = "image/jpeg"): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}
