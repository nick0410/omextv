import path from "path";
import dotenv from "dotenv";

dotenv.config();

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`env ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function float(name: string, fallback: number, min = -Infinity, max = Infinity): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`env ${name} must be a number, got "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`env ${name} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function str(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

const NODE_ENV = str("NODE_ENV", "development");
const IS_PROD = NODE_ENV === "production";

const JWT_SECRET = str("JWT_SECRET", "dev-secret-change-me");
// A default secret in production means every token is forgeable. Refuse to boot.
if (IS_PROD && (JWT_SECRET === "dev-secret-change-me" || JWT_SECRET.length < 32)) {
  throw new Error(
    "JWT_SECRET must be set to a random value of at least 32 characters in production",
  );
}

export type GenderProviderName = "mock" | "onnx" | "http";

const providerRaw = str("GENDER_PROVIDER", "mock");
if (!["mock", "onnx", "http"].includes(providerRaw)) {
  throw new Error(`GENDER_PROVIDER must be one of mock|onnx|http, got "${providerRaw}"`);
}

export const env = {
  PORT: int("PORT", 3001),
  NODE_ENV,
  IS_PROD,
  DATABASE_URL: str("DATABASE_URL", "file:./prisma/dev.db"),

  JWT_SECRET,
  JWT_EXPIRES_IN: str("JWT_EXPIRES_IN", "7d"),
  CLIENT_URL: str("CLIENT_URL", "http://localhost:5173"),
  /** Comma-separated extra origins allowed to call the API. */
  ALLOWED_ORIGINS: str("ALLOWED_ORIGINS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // --- Scaling ---
  /**
   * Set to run more than one instance. Empty means single-process in-memory
   * state, which is faster but cannot be scaled horizontally.
   */
  REDIS_URL: str("REDIS_URL"),
  /** Identifies this node when routing events between instances. */
  INSTANCE_ID: str("INSTANCE_ID", `${process.pid}-${Math.random().toString(36).slice(2, 8)}`),

  // --- WebRTC / TURN ---
  STUN_URLS: str("STUN_URLS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  TURN_SERVER_URL: str("TURN_SERVER_URL"),
  /**
   * Comma-separated extra TURN URLs (e.g. a TLS variant on 443, which is what
   * gets through restrictive corporate firewalls).
   */
  TURN_URLS: str("TURN_URLS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  TURN_SERVER_USERNAME: str("TURN_SERVER_USERNAME"),
  TURN_SERVER_CREDENTIAL: str("TURN_SERVER_CREDENTIAL"),
  /**
   * Shared secret for coturn's REST API (`static-auth-secret` + `use-auth-secret`).
   * When set, each client is issued short-lived HMAC credentials instead of a
   * fixed username/password — a static credential handed to every browser is a
   * standing invitation to have your relay bandwidth stolen.
   */
  TURN_SECRET: str("TURN_SECRET"),
  TURN_TTL_SECONDS: int("TURN_TTL_SECONDS", 3600),
  TURN_REALM: str("TURN_REALM", "omextv"),

  RAZORPAY_KEY_ID: str("RAZORPAY_KEY_ID"),
  RAZORPAY_KEY_SECRET: str("RAZORPAY_KEY_SECRET"),

  // --- Gender inference ---
  GENDER_PROVIDER: providerRaw as GenderProviderName,
  GENDER_CONFIDENCE_THRESHOLD: float("GENDER_CONFIDENCE_THRESHOLD", 0.75, 0, 1),
  /** How long a verification stays usable before matching falls back to declared. */
  GENDER_FRESHNESS_HOURS: float("GENDER_FRESHNESS_HOURS", 24, 0.01, 24 * 365),
  GENDER_MODEL_DIR: str("GENDER_MODEL_DIR", path.join(process.cwd(), "models")),
  /**
   * Which classifier is in GENDER_MODEL_DIR. Drives every preprocessing
   * decision — input size, channel order, normalization, crop padding and
   * which output index means which gender. Getting it wrong does not crash,
   * it just makes the model quietly worse.
   */
  GENDER_CLASSIFIER: (() => {
    const raw = str("GENDER_CLASSIFIER", "insightface");
    if (raw !== "insightface" && raw !== "googlenet") {
      throw new Error(
        `GENDER_CLASSIFIER must be "insightface" or "googlenet", got "${raw}"`,
      );
    }
    return raw as "insightface" | "googlenet";
  })(),
  /**
   * Which class index the classifier assigns to which gender. The bundled
   * GoogLeNet model is ['Male','Female']; a different build may be reversed,
   * which would invert every prediction. Verify with scripts/gender-check.ts.
   */
  GENDER_CLASS_ORDER: (() => {
    const raw = str("GENDER_CLASS_ORDER", "").toLowerCase().trim();
    // Empty means "trust the classifier spec", which is almost always right.
    if (raw === "") return undefined;
    if (raw === "female,male") return ["female", "male"] as const;
    if (raw === "male,female") return ["male", "female"] as const;
    throw new Error(
      `GENDER_CLASS_ORDER must be "male,female", "female,male" or empty, got "${raw}"`,
    );
  })(),
  GENDER_API_URL: str("GENDER_API_URL"),
  GENDER_API_KEY: str("GENDER_API_KEY"),
  /**
   * Minimum share of the frame a face must occupy to be counted.
   *
   * Doing double duty: it keeps a person in the background (or a poster on the
   * wall) from tripping the "multiple faces" rejection, and it guarantees the
   * crop has enough pixels to classify. On a 640x480 frame the 0.01 default is
   * roughly a 55x55 px face. A webcam user typically fills 5-25%.
   */
  GENDER_MIN_FACE_AREA: float("GENDER_MIN_FACE_AREA", 0.01, 0, 1),
  GENDER_DETECT_THRESHOLD: float("GENDER_DETECT_THRESHOLD", 0.7, 0, 1),
  /** Require a fresh verification before a user may enter the queue at all. */
  REQUIRE_GENDER_VERIFICATION: str("REQUIRE_GENDER_VERIFICATION", "false") === "true",

  // --- Matchmaking ---
  /** How often the sweep re-evaluates waiting users, in ms. */
  MATCH_SWEEP_INTERVAL_MS: int("MATCH_SWEEP_INTERVAL_MS", 2_000),
  /** Grace period for a dropped socket to reconnect before the partner is freed. */
  RECONNECT_GRACE_MS: int("RECONNECT_GRACE_MS", 8_000),
  /** Chats idle longer than this are reaped. 0 disables. */
  CHAT_IDLE_TIMEOUT_MS: int("CHAT_IDLE_TIMEOUT_MS", 0),
  /** Recent-partner memory kept per user, in entries. */
  RECENT_PARTNER_LIMIT: int("RECENT_PARTNER_LIMIT", 50),

  // --- Abuse limits ---
  QUEUE_JOINS_PER_MIN: int("QUEUE_JOINS_PER_MIN", 30),
  MESSAGES_PER_MIN: int("MESSAGES_PER_MIN", 60),
  SIGNALS_PER_MIN: int("SIGNALS_PER_MIN", 600),
  MAX_MESSAGE_LENGTH: int("MAX_MESSAGE_LENGTH", 1000),
  /**
   * Failed sign-ins allowed per IP per window before throttling.
   *
   * Deliberately small: password guessing is the attack this stops, and a
   * person who has genuinely forgotten their password does not need dozens of
   * tries a minute. Successful sign-ins are not counted against it.
   */
  LOGIN_ATTEMPTS_PER_15MIN: int("LOGIN_ATTEMPTS_PER_15MIN", 10),
  /**
   * New accounts allowed per IP per hour.
   *
   * Higher than it first looks like it should be, because mobile carriers and
   * campus networks put thousands of people behind one address — a tight limit
   * there locks out a whole college to stop one script.
   */
  SIGNUPS_PER_HOUR: int("SIGNUPS_PER_HOUR", 20),
  /** Ceiling on all other API calls per IP per minute. */
  API_REQUESTS_PER_MIN: int("API_REQUESTS_PER_MIN", 300),

  /** Reports needed before an automatic temporary ban. 0 disables. */
  AUTO_BAN_REPORT_THRESHOLD: int("AUTO_BAN_REPORT_THRESHOLD", 5),
  AUTO_BAN_HOURS: int("AUTO_BAN_HOURS", 24),
};
