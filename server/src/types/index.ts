export interface JWTPayload {
  userId: string;
  email: string;
}

/** Self-declared gender. "other" is a first-class value, never inferred. */
export type Gender = "male" | "female" | "other";

/** What the vision model is able to output. It cannot infer "other". */
export type InferredGender = "male" | "female" | "unknown";

/** What a user asks to be matched with. "any" means no constraint. */
export type GenderPreference = Gender | "any";

export interface MatchFilters {
  /** "any" = no gender constraint. */
  gender: GenderPreference;
  /** ISO 3166-1 alpha-2, uppercase. Empty = anywhere in the world. */
  countries: string[];
  /** Only meaningful alongside exactly one country. Empty = any city. */
  city: string | null;
}

export const DEFAULT_FILTERS: MatchFilters = {
  gender: "any",
  countries: [],
  city: null,
};

/**
 * A user waiting to be matched.
 *
 * `blockedIds` and `recentPartners` are snapshotted from the database at
 * enqueue time on purpose: the matcher must run start-to-finish synchronously
 * to be atomic, so it cannot await a query mid-scan.
 */
export interface QueueEntry {
  userId: string;
  socketId: string;
  username: string;
  /** Self-declared. */
  gender: Gender;
  /** Model-inferred, if a fresh confident reading exists. */
  verifiedGender: InferredGender | null;
  /** What other users' gender filters are tested against. */
  effectiveGender: Gender;
  /** True when effectiveGender came from the model rather than self-report. */
  genderIsVerified: boolean;
  country: string | null;
  city: string | null;
  isPremium: boolean;
  filters: MatchFilters;
  /** Users this person blocked, or who blocked them. Never relaxed. */
  blockedIds: Set<string>;
  /** userId -> epoch ms of the last chat with them. */
  recentPartners: Map<string, number>;
  joinedAt: number;
  /** Bumped each time a relaxation stage is entered, for observability. */
  relaxStage: number;
}

export interface MatchResult {
  roomId: string;
  a: QueueEntry;
  b: QueueEntry;
  /** Which relaxation stage produced the match. */
  stage: number;
  /** Constraints in play, persisted onto ChatSession for debugging. */
  matchedOn: {
    aFilters: MatchFilters;
    bFilters: MatchFilters;
    aWaitedMs: number;
    bWaitedMs: number;
  };
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export type EndReason =
  | "skip"
  | "end"
  | "disconnect"
  | "reported"
  | "timeout"
  | "server_shutdown";
