import { QueueEntry } from "../../types";

/**
 * Backing store for everything that has to be shared between server instances.
 *
 * The single-process implementation keeps all of this in plain Maps. The Redis
 * implementation is what makes horizontal scaling possible: without it, two
 * instances each hold their own queue, and a user on instance A can never be
 * matched with a user on instance B.
 *
 * Every method is async because the Redis backend must be — the in-memory one
 * simply resolves immediately.
 */
export interface PresenceStore {
  /**
   * Record a connection.
   * @returns the socket id displaced, if the user was already online elsewhere.
   */
  register(userId: string, socketId: string, instanceId: string): Promise<string | null>;
  unregister(socketId: string): Promise<{ userId: string; socketId: string } | null>;
  socketOf(userId: string): Promise<string | null>;
  /** Which instance owns this user's socket, for cross-instance delivery. */
  instanceOf(userId: string): Promise<string | null>;
  isOnline(userId: string): Promise<boolean>;
  isCurrentSocket(userId: string, socketId: string): Promise<boolean>;
  onlineCount(): Promise<number>;
  onlineUserIds(limit?: number): Promise<string[]>;
  /** Refresh the liveness TTL so a crashed instance's entries expire. */
  heartbeat(userId: string, socketId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PairRecord {
  roomId: string;
  userAId: string;
  userBId: string;
  startedAt: number;
  dbId: string | null;
  messageCount: number;
  lastActivityAt: number;
}

export interface PairingStore {
  create(pair: PairRecord): Promise<void>;
  pairOf(userId: string): Promise<PairRecord | null>;
  pairByRoom(roomId: string): Promise<PairRecord | null>;
  partnerOf(userId: string): Promise<string | null>;
  isPaired(userId: string): Promise<boolean>;
  isMember(userId: string, roomId: string): Promise<boolean>;
  end(roomId: string): Promise<PairRecord | null>;
  endForUser(userId: string): Promise<PairRecord | null>;
  noteMessage(roomId: string, now: number): Promise<void>;
  touch(roomId: string, now: number): Promise<void>;
  activeCount(): Promise<number>;
  allPairs(limit?: number): Promise<PairRecord[]>;
  findIdle(idleMs: number, now: number): Promise<PairRecord[]>;

  rememberPartner(userId: string, partnerId: string, now: number): Promise<void>;
  recentPartnersOf(userId: string): Promise<Map<string, number>>;
  sweepRecent(maxAgeMs: number, now: number): Promise<number>;
  clear(): Promise<void>;
}

/**
 * The queue.
 *
 * Matching stays a synchronous, single-owner operation even in the distributed
 * case — see `withLock`. Splitting the scan across instances would reintroduce
 * exactly the double-booking race the single-process design eliminates.
 */
export interface QueueStore {
  enqueue(entry: QueueEntry): Promise<void>;
  remove(userId: string): Promise<QueueEntry | null>;
  has(userId: string): Promise<boolean>;
  get(userId: string): Promise<QueueEntry | null>;
  /** Oldest-first, premium lane before standard. */
  snapshot(): Promise<{ premium: QueueEntry[]; standard: QueueEntry[] }>;
  size(): Promise<number>;
  laneSizes(): Promise<{ premium: number; standard: number }>;
  positionOf(userId: string): Promise<number>;
  oldestWaitMs(now: number): Promise<number>;
  clear(): Promise<void>;

  /**
   * Run `fn` holding an exclusive matchmaking lock.
   *
   * In-memory this is a no-op (the runtime is already single-threaded). On
   * Redis it is a real distributed lock, so only one instance matches at a
   * time and no user is handed to two partners.
   */
  withLock<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T | null>;
}

/** Cross-instance fan-out so an event can reach a socket on another node. */
export interface StoreBus {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (message: unknown) => void): Promise<void>;
  close(): Promise<void>;
}

export interface Stores {
  readonly kind: "memory" | "redis";
  presence: PresenceStore;
  pairing: PairingStore;
  queue: QueueStore;
  bus: StoreBus;
  /** Liveness probe used by /health. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
