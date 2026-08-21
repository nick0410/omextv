import Redis, { Redis as RedisClient } from "ioredis";
import { randomUUID } from "crypto";
import { QueueEntry } from "../../types";
import {
  Stores,
  PresenceStore,
  PairingStore,
  QueueStore,
  StoreBus,
  PairRecord,
} from "./types";
import { serializeEntry, deserializeEntry } from "./serialize";

const K = {
  userPresence: (id: string) => `omextv:presence:user:${id}`,
  socketOwner: (id: string) => `omextv:presence:socket:${id}`,
  onlineSet: "omextv:presence:online",

  pairRoom: (id: string) => `omextv:pair:room:${id}`,
  pairUser: (id: string) => `omextv:pair:user:${id}`,
  pairIndex: "omextv:pair:index",
  recent: (id: string) => `omextv:recent:${id}`,

  queueLane: (lane: "premium" | "standard") => `omextv:queue:${lane}`,
  queueEntry: (id: string) => `omextv:queue:entry:${id}`,
  queueLock: "omextv:queue:lock",
} as const;

/** How long a presence record survives without a heartbeat. */
const PRESENCE_TTL_SEC = 90;

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * Registering has to be atomic: read whoever held this user's slot, replace
 * it, and drop the old socket's reverse index in one step. Doing that as three
 * round-trips lets two simultaneous logins interleave and leave a reverse
 * index pointing at a socket that no longer owns the user.
 */
const REGISTER_LUA = `
local userKey   = KEYS[1]
local onlineSet = KEYS[2]
local userId    = ARGV[1]
local socketId  = ARGV[2]
local instance  = ARGV[3]
local now       = tonumber(ARGV[4])
local ttl       = tonumber(ARGV[5])
local prefix    = ARGV[6]

local previous = redis.call('HGET', userKey, 'socketId')
if previous and previous ~= socketId then
  redis.call('DEL', prefix .. previous)
end

redis.call('HSET', userKey, 'socketId', socketId, 'instance', instance, 'at', now)
redis.call('EXPIRE', userKey, ttl)
redis.call('SET', prefix .. socketId, userId, 'EX', ttl)
redis.call('ZADD', onlineSet, now, userId)

if previous and previous ~= socketId then return previous end
return false
`;

/**
 * Unregister must not clear a record that already belongs to a newer socket —
 * a late disconnect from a replaced connection would otherwise sign the user
 * out of the session that replaced it.
 */
const UNREGISTER_LUA = `
local socketKey = KEYS[1]
local onlineSet = KEYS[2]
local socketId  = ARGV[1]
local prefix    = ARGV[2]

local userId = redis.call('GET', socketKey)
if not userId then return false end
redis.call('DEL', socketKey)

local current = redis.call('HGET', prefix .. userId, 'socketId')
if current == socketId then
  redis.call('DEL', prefix .. userId)
  redis.call('ZREM', onlineSet, userId)
end
return userId
`;

class RedisPresenceStore implements PresenceStore {
  constructor(private redis: RedisClient) {}

  async register(userId: string, socketId: string, instanceId: string) {
    const result = await this.redis.eval(
      REGISTER_LUA,
      2,
      K.userPresence(userId),
      K.onlineSet,
      userId,
      socketId,
      instanceId,
      String(Date.now()),
      String(PRESENCE_TTL_SEC),
      "omextv:presence:socket:",
    );
    return typeof result === "string" ? result : null;
  }

  async unregister(socketId: string) {
    const userId = await this.redis.eval(
      UNREGISTER_LUA,
      2,
      K.socketOwner(socketId),
      K.onlineSet,
      socketId,
      "omextv:presence:user:",
    );
    return typeof userId === "string" ? { userId, socketId } : null;
  }

  async socketOf(userId: string) {
    return this.redis.hget(K.userPresence(userId), "socketId");
  }

  async instanceOf(userId: string) {
    return this.redis.hget(K.userPresence(userId), "instance");
  }

  async isOnline(userId: string) {
    return (await this.redis.exists(K.userPresence(userId))) === 1;
  }

  async isCurrentSocket(userId: string, socketId: string) {
    return (await this.socketOf(userId)) === socketId;
  }

  async onlineCount() {
    // Entries whose hash has expired may linger in the sorted set, so count by
    // freshness rather than trusting ZCARD.
    await this.sweepStale();
    return this.redis.zcard(K.onlineSet);
  }

  async onlineUserIds(limit = 10_000) {
    await this.sweepStale();
    return this.redis.zrevrange(K.onlineSet, 0, limit - 1);
  }

  async heartbeat(userId: string, socketId: string) {
    const now = Date.now();
    await this.redis
      .multi()
      .expire(K.userPresence(userId), PRESENCE_TTL_SEC)
      .expire(K.socketOwner(socketId), PRESENCE_TTL_SEC)
      .zadd(K.onlineSet, now, userId)
      .exec();
  }

  /** Drop users whose presence hash expired — i.e. whose instance died. */
  private async sweepStale() {
    const cutoff = Date.now() - PRESENCE_TTL_SEC * 1000;
    await this.redis.zremrangebyscore(K.onlineSet, "-inf", cutoff);
  }

  async clear() {
    const ids = await this.redis.zrange(K.onlineSet, 0, -1);
    const pipeline = this.redis.multi();
    for (const id of ids) pipeline.del(K.userPresence(id));
    pipeline.del(K.onlineSet);
    await pipeline.exec();
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

function toPair(hash: Record<string, string>): PairRecord | null {
  if (!hash || !hash.roomId) return null;
  return {
    roomId: hash.roomId,
    userAId: hash.userAId,
    userBId: hash.userBId,
    startedAt: Number(hash.startedAt),
    dbId: hash.dbId || null,
    messageCount: Number(hash.messageCount ?? 0),
    lastActivityAt: Number(hash.lastActivityAt),
  };
}

class RedisPairingStore implements PairingStore {
  constructor(private redis: RedisClient) {}

  async create(pair: PairRecord) {
    // Clear any stale pair either side is still attached to, exactly as the
    // in-memory registry does, so nobody ends up in two rooms.
    for (const userId of [pair.userAId, pair.userBId]) {
      const existing = await this.redis.get(K.pairUser(userId));
      if (existing && existing !== pair.roomId) await this.end(existing);
    }

    await this.redis
      .multi()
      .hset(K.pairRoom(pair.roomId), {
        roomId: pair.roomId,
        userAId: pair.userAId,
        userBId: pair.userBId,
        startedAt: String(pair.startedAt),
        dbId: pair.dbId ?? "",
        messageCount: String(pair.messageCount),
        lastActivityAt: String(pair.lastActivityAt),
      })
      .set(K.pairUser(pair.userAId), pair.roomId)
      .set(K.pairUser(pair.userBId), pair.roomId)
      .zadd(K.pairIndex, pair.lastActivityAt, pair.roomId)
      .exec();

    await Promise.all([
      this.rememberPartner(pair.userAId, pair.userBId, pair.startedAt),
      this.rememberPartner(pair.userBId, pair.userAId, pair.startedAt),
    ]);
  }

  async pairOf(userId: string) {
    const roomId = await this.redis.get(K.pairUser(userId));
    return roomId ? this.pairByRoom(roomId) : null;
  }

  async pairByRoom(roomId: string) {
    return toPair(await this.redis.hgetall(K.pairRoom(roomId)));
  }

  async partnerOf(userId: string) {
    const pair = await this.pairOf(userId);
    if (!pair) return null;
    return pair.userAId === userId ? pair.userBId : pair.userAId;
  }

  async isPaired(userId: string) {
    return (await this.redis.exists(K.pairUser(userId))) === 1;
  }

  async isMember(userId: string, roomId: string) {
    const pair = await this.pairByRoom(roomId);
    if (!pair) return false;
    return pair.userAId === userId || pair.userBId === userId;
  }

  async end(roomId: string) {
    const pair = await this.pairByRoom(roomId);
    if (!pair) return null;
    await this.redis
      .multi()
      .del(K.pairRoom(roomId))
      .del(K.pairUser(pair.userAId))
      .del(K.pairUser(pair.userBId))
      .zrem(K.pairIndex, roomId)
      .exec();
    return pair;
  }

  async endForUser(userId: string) {
    const roomId = await this.redis.get(K.pairUser(userId));
    return roomId ? this.end(roomId) : null;
  }

  async noteMessage(roomId: string, now: number) {
    await this.redis
      .multi()
      .hincrby(K.pairRoom(roomId), "messageCount", 1)
      .hset(K.pairRoom(roomId), "lastActivityAt", String(now))
      .zadd(K.pairIndex, now, roomId)
      .exec();
  }

  async touch(roomId: string, now: number) {
    await this.redis
      .multi()
      .hset(K.pairRoom(roomId), "lastActivityAt", String(now))
      .zadd(K.pairIndex, now, roomId)
      .exec();
  }

  async activeCount() {
    return this.redis.zcard(K.pairIndex);
  }

  async allPairs(limit = 10_000) {
    const roomIds = await this.redis.zrange(K.pairIndex, 0, limit - 1);
    const pairs = await Promise.all(roomIds.map((id) => this.pairByRoom(id)));
    return pairs.filter((p): p is PairRecord => p !== null);
  }

  async findIdle(idleMs: number, now: number) {
    // The index is scored by last activity, so idle rooms are simply the ones
    // scoring below the cutoff — no scan of every room needed.
    const roomIds = await this.redis.zrangebyscore(K.pairIndex, "-inf", now - idleMs);
    const pairs = await Promise.all(roomIds.map((id) => this.pairByRoom(id)));
    return pairs.filter((p): p is PairRecord => p !== null);
  }

  async rememberPartner(userId: string, partnerId: string, now: number) {
    const key = K.recent(userId);
    await this.redis
      .multi()
      .zadd(key, now, partnerId)
      // Keep only the most recent 50 (index 0..-51 are the older ones).
      .zremrangebyrank(key, 0, -51)
      .expire(key, 60 * 60)
      .exec();
  }

  async recentPartnersOf(userId: string) {
    const flat = await this.redis.zrange(K.recent(userId), 0, -1, "WITHSCORES");
    const map = new Map<string, number>();
    for (let i = 0; i < flat.length; i += 2) map.set(flat[i], Number(flat[i + 1]));
    return map;
  }

  async sweepRecent(maxAgeMs: number, now: number) {
    // Individual keys carry a TTL, so this only trims within live keys.
    const keys = await this.scanKeys("omextv:recent:*");
    let dropped = 0;
    for (const key of keys) {
      dropped += await this.redis.zremrangebyscore(key, "-inf", now - maxAgeMs);
    }
    return dropped;
  }

  /** SCAN rather than KEYS — KEYS blocks the server on a large keyspace. */
  private async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = next;
      found.push(...batch);
    } while (cursor !== "0");
    return found;
  }

  async clear() {
    const keys = [
      ...(await this.scanKeys("omextv:pair:*")),
      ...(await this.scanKeys("omextv:recent:*")),
    ];
    if (keys.length > 0) await this.redis.del(...keys);
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Release the lock only if we still own it, so a slow holder cannot free someone else's. */
const UNLOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

class RedisQueueStore implements QueueStore {
  constructor(private redis: RedisClient) {}

  async enqueue(entry: QueueEntry) {
    const lane = entry.isPremium ? "premium" : "standard";
    const other = entry.isPremium ? "standard" : "premium";
    await this.redis
      .multi()
      .zrem(K.queueLane(other), entry.userId)
      // ZADD scored by joinedAt: ordering is by wait time, and a re-join with
      // the original timestamp keeps the user's place rather than sending them
      // to the back.
      .zadd(K.queueLane(lane), entry.joinedAt, entry.userId)
      .set(K.queueEntry(entry.userId), serializeEntry(entry))
      .exec();
  }

  async remove(userId: string) {
    const entry = await this.get(userId);
    if (!entry) {
      // Still clear the lane indexes in case the payload expired first.
      await this.redis
        .multi()
        .zrem(K.queueLane("premium"), userId)
        .zrem(K.queueLane("standard"), userId)
        .exec();
      return null;
    }
    await this.redis
      .multi()
      .zrem(K.queueLane("premium"), userId)
      .zrem(K.queueLane("standard"), userId)
      .del(K.queueEntry(userId))
      .exec();
    return entry;
  }

  async has(userId: string) {
    const [p, s] = await Promise.all([
      this.redis.zscore(K.queueLane("premium"), userId),
      this.redis.zscore(K.queueLane("standard"), userId),
    ]);
    return p !== null || s !== null;
  }

  async get(userId: string) {
    return deserializeEntry(await this.redis.get(K.queueEntry(userId)));
  }

  private async lane(name: "premium" | "standard"): Promise<QueueEntry[]> {
    const ids = await this.redis.zrange(K.queueLane(name), 0, -1);
    if (ids.length === 0) return [];
    const raw = await this.redis.mget(ids.map(K.queueEntry));
    const entries: QueueEntry[] = [];
    for (let i = 0; i < ids.length; i++) {
      const entry = deserializeEntry(raw[i]);
      if (entry) entries.push(entry);
      // A missing payload means the entry expired; drop the dangling index.
      else await this.redis.zrem(K.queueLane(name), ids[i]);
    }
    return entries;
  }

  async snapshot() {
    const [premium, standard] = await Promise.all([
      this.lane("premium"),
      this.lane("standard"),
    ]);
    return { premium, standard };
  }

  async size() {
    const { premium, standard } = await this.laneSizes();
    return premium + standard;
  }

  async laneSizes() {
    const [premium, standard] = await Promise.all([
      this.redis.zcard(K.queueLane("premium")),
      this.redis.zcard(K.queueLane("standard")),
    ]);
    return { premium, standard };
  }

  async positionOf(userId: string) {
    const premiumRank = await this.redis.zrank(K.queueLane("premium"), userId);
    if (premiumRank !== null) return premiumRank + 1;

    const standardRank = await this.redis.zrank(K.queueLane("standard"), userId);
    if (standardRank !== null) {
      const premiumSize = await this.redis.zcard(K.queueLane("premium"));
      return premiumSize + standardRank + 1;
    }
    return -1;
  }

  async oldestWaitMs(now: number) {
    const [p, s] = await Promise.all([
      this.redis.zrange(K.queueLane("premium"), 0, 0, "WITHSCORES"),
      this.redis.zrange(K.queueLane("standard"), 0, 0, "WITHSCORES"),
    ]);
    const scores = [p[1], s[1]].filter(Boolean).map(Number);
    if (scores.length === 0) return 0;
    return Math.max(0, now - Math.min(...scores));
  }

  /**
   * Distributed mutual exclusion for matchmaking.
   *
   * Only one instance runs the matcher at a time, which is what preserves the
   * single-process guarantee that nobody is handed two partners. Returns null
   * if the lock could not be taken — the caller simply tries again on the next
   * sweep rather than matching unsafely.
   */
  async withLock<T>(fn: () => Promise<T>, timeoutMs = 5_000): Promise<T | null> {
    const token = randomUUID();
    const acquired = await this.redis.set(K.queueLock, token, "PX", timeoutMs, "NX");
    if (acquired !== "OK") return null;

    try {
      return await fn();
    } finally {
      await this.redis.eval(UNLOCK_LUA, 1, K.queueLock, token);
    }
  }

  async clear() {
    const keys: string[] = [K.queueLane("premium"), K.queueLane("standard")];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        "MATCH",
        "omextv:queue:entry:*",
        "COUNT",
        200,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length > 0) await this.redis.del(...keys);
  }
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

class RedisBus implements StoreBus {
  private handlers = new Map<string, ((message: unknown) => void)[]>();

  /** ioredis requires a dedicated connection once it enters subscriber mode. */
  constructor(
    private publisher: RedisClient,
    private subscriber: RedisClient,
  ) {
    this.subscriber.on("message", (channel, payload) => {
      const listeners = this.handlers.get(channel);
      if (!listeners) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      for (const listener of listeners) listener(parsed);
    });
  }

  async publish(channel: string, message: unknown) {
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, handler: (message: unknown) => void) {
    const existing = this.handlers.get(channel);
    if (existing) {
      existing.push(handler);
      return;
    }
    this.handlers.set(channel, [handler]);
    await this.subscriber.subscribe(channel);
  }

  async close() {
    this.handlers.clear();
    await this.subscriber.quit().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

export class RedisStores implements Stores {
  readonly kind = "redis" as const;
  presence: PresenceStore;
  pairing: PairingStore;
  queue: QueueStore;
  bus: StoreBus;

  private clients: RedisClient[];

  constructor(url: string) {
    const main = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    const sub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });

    // Without a handler an ioredis error becomes an unhandled 'error' event and
    // takes the process down; a Redis blip should degrade, not crash.
    for (const client of [main, sub]) {
      client.on("error", (err) => console.error("[redis]", err.message));
    }

    this.clients = [main, sub];
    this.presence = new RedisPresenceStore(main);
    this.pairing = new RedisPairingStore(main);
    this.queue = new RedisQueueStore(main);
    this.bus = new RedisBus(main, sub);
  }

  async ping() {
    try {
      return (await this.clients[0].ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close() {
    await this.bus.close();
    await Promise.allSettled(this.clients.map((c) => c.quit()));
  }
}
