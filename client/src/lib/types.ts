/** Mirrors the server's socket and HTTP contracts. */

export type Gender = "male" | "female" | "other";
export type GenderPreference = Gender | "any";

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
  unstable: "The frames disagreed with each other. Hold still, face the camera straight on, and make sure the light is even.",
  no_face: "No face detected. Centre yourself in frame.",
  multiple_faces: "More than one face in frame. Make sure only you are visible.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  invalid_image: "That image could not be read.",
  provider_unavailable: "Verification is unavailable right now.",
  user_not_found: "Account not found. Try signing in again.",
};
