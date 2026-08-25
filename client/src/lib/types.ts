/** Mirrors the server's socket and HTTP contracts. */

export type Gender = "male" | "female";
export type GenderPreference = Gender | "any";

/**
 * Who to suggest by default.
 *
 * The server still accepts and stores "other" for accounts created before it
 * was removed from the sign-up form, so anything reading a gender off the API
 * has to tolerate it — hence the widened parameter type here rather than
 * `Gender`.
 */
export function oppositeGender(gender: string | null | undefined): GenderPreference {
  if (gender === "male") return "female";
  if (gender === "female") return "male";
  return "any";
}

export interface MatchFilters {
  gender: GenderPreference;
  countries: string[];
  city: string | null;
}

export const DEFAULT_FILTERS: MatchFilters = {
  gender: "any",
  countries: [],
  city: null,
};

/** What you are allowed to learn about the person you were matched with. */
export interface PartnerProfile {
  userId: string;
  username: string;
  gender: Gender;
  genderVerified: boolean;
  country: string | null;
  city: string | null;
  isPremium: boolean;
}

export interface MatchFound {
  roomId: string;
  isInitiator: boolean;
  partner: PartnerProfile;
  waitedMs: number;
  relaxStage: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export interface QueueJoined {
  position: number;
  size: number;
  filters: MatchFilters;
}

export interface QueueError {
  code:
    | "rate_limited"
    | "already_in_chat"
    | "verification_required"
    | "internal";
  message: string;
  retryAfterMs?: number;
}

export type EndReason =
  | "skip"
  | "end"
  | "disconnect"
  | "reported"
  | "timeout"
  | "server_shutdown";

export type VerificationOutcome =
  | "accepted"
  | "low_confidence"
  | "unstable"
  | "no_face"
  | "multiple_faces"
  | "rate_limited"
  | "invalid_image"
  | "provider_unavailable"
  | "user_not_found";

export interface GenderVerifyResult {
  ok: boolean;
  outcome: VerificationOutcome;
  gender: "male" | "female" | null;
  confidence: number;
  mismatch: boolean;
  retryAfterMs?: number;
  framesUsed?: number;
  agreement?: number;
}

export interface IceConfig {
  iceServers: RTCIceServer[];
  expiresAt: number | null;
  hasTurn: boolean;
}

/** Where the user is in the whole flow. Drives what the Chat screen renders. */
export type CallPhase =
  | "idle"
  | "requesting-camera"
  | "camera-denied"
  | "queued"
  | "connecting"
  | "live"
  | "partner-lost"
  | "ended";

export const OUTCOME_COPY: Record<VerificationOutcome, string> = {
  accepted: "Verified.",
  low_confidence: "Not a clear enough read. Try better lighting, facing the camera.",
  unstable: "The frames disagreed with each other.",
  no_face: "No face detected. Centre yourself in frame.",
  multiple_faces: "More than one face in frame. Make sure only you are visible.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  invalid_image: "That image could not be read.",
  provider_unavailable: "Verification is unavailable right now.",
  user_not_found: "Account not found. Try signing in again.",
};

// --- Coins and premium -----------------------------------------------------

/** Rupees to coins. Priced by the server; the client never computes a price. */
export interface CoinPack {
  id: string;
  name: string;
  amountPaise: number;
  coins: number;
  bonusCoins: number;
  best?: boolean;
}

/** Coins to premium days. */
export interface CoinPass {
  id: string;
  name: string;
  cost: number;
  days: number;
}

export type CoinOrderStatus =
  | "awaiting_payment"
  | "under_review"
  | "approved"
  | "rejected";

export interface CoinOrder {
  id: string;
  packId: string;
  coins: number;
  amountPaise: number;
  status: CoinOrderStatus;
  paymentRef: string | null;
  note: string | null;
  createdAt: string;
}

/**
 * What the buyer needs in order to pay, built by the server.
 *
 * A union, mirroring the server: paying by transfer and paying inside a hosted
 * checkout are different things, not one thing with optional fields. The
 * `kind` is what the page branches on.
 */
export type PaymentInstruction = TransferInstruction | GatewayInstruction;

/** Scan or tap a link, then tell us the reference afterwards. */
export interface TransferInstruction {
  kind: "transfer";
  provider: string;
  link: string;
  payee: string;
  payeeName: string;
  amountRupees: string;
  reference: string;
}

/** Pay inside the provider's own window; it reports the result to the server. */
export interface GatewayInstruction {
  kind: "gateway";
  provider: string;
  /** Publishable key. The secret never leaves the server. */
  keyId: string;
  gatewayOrderId: string;
  amountPaise: number;
  amountRupees: string;
  currency: string;
  reference: string;
}

export interface Wallet {
  coins: number;
  isPremium: boolean;
  premiumExpiry: string | null;
  packs: CoinPack[];
  passes: CoinPass[];
  /** False when no payee is configured — the client hides buying entirely. */
  purchasesEnabled: boolean;
}
