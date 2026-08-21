import { EventEmitter } from "events";
import { PresenceRegistry } from "../presence";
import { PairingRegistry } from "../pairing";
import { FifoQueue } from "../matchmaking/queue";
import { QueueEntry } from "../../types";
import {
  Stores,
  PresenceStore,
  PairingStore,
  QueueStore,
  StoreBus,
  PairRecord,
} from "./types";

/**
 * Single-process backend.
 *
 * These are thin async wrappers over the synchronous registries, which stay
 * the reference implementation: they are the ones the bulk of the test suite
 * exercises directly, and they remain the fastest option when only one
 * instance is running.
 */

class MemoryPresenceStore implements PresenceStore {
  private registry = new PresenceRegistry();

  async register(userId: string, socketId: string): Promise<string | null> {
    return this.registry.register(userId, socketId);
  }
  async unregister(socketId: string) {
    const rec = this.registry.unregister(socketId);
    return rec ? { userId: rec.userId, socketId: rec.socketId } : null;
  }
  async socketOf(userId: string) {
    return this.registry.socketOf(userId);
  }
  async instanceOf(userId: string) {
    // Only one instance exists, so anyone online is local.
    return this.registry.isOnline(userId) ? "local" : null;
  }
  async isOnline(userId: string) {
    return this.registry.isOnline(userId);
  }
  async isCurrentSocket(userId: string, socketId: string) {
    return this.registry.isCurrentSocket(userId, socketId);
  }
  async onlineCount() {
    return this.registry.onlineCount;
  }
  async onlineUserIds(limit?: number) {
    const ids = this.registry.onlineUserIds();
    return limit ? ids.slice(0, limit) : ids;
  }
  async heartbeat(socketId: string) {
    this.registry.touch(socketId);
  }
  async clear() {
    this.registry.clear();
  }

  /** Escape hatch for the synchronous hot paths that still use it directly. */
  raw(): PresenceRegistry {
    return this.registry;
  }
}

class MemoryPairingStore implements PairingStore {
  private registry = new PairingRegistry();

  async create(pair: PairRecord) {
    const created = this.registry.create(
      pair.roomId,
      pair.userAId,
      pair.userBId,
      pair.startedAt,
    );
    created.dbId = pair.dbId;
  }
  async pairOf(userId: string) {
    return this.registry.pairOf(userId);
  }
  async pairByRoom(roomId: string) {
    return this.registry.pairByRoom(roomId);
  }
  async partnerOf(userId: string) {
    return this.registry.partnerOf(userId);
  }
  async isPaired(userId: string) {
    return this.registry.isPaired(userId);
  }
  async isMember(userId: string, roomId: string) {
    return this.registry.isMember(userId, roomId);
  }
  async end(roomId: string) {
    return this.registry.end(roomId);
  }
  async endForUser(userId: string) {
    return this.registry.endForUser(userId);
  }
  async noteMessage(roomId: string, now: number) {
    this.registry.noteMessage(roomId, now);
  }
  async touch(roomId: string, now: number) {
    this.registry.touch(roomId, now);
  }
  async activeCount() {
    return this.registry.activeCount;
  }
  async allPairs(limit?: number) {
    const all = this.registry.allPairs();
    return limit ? all.slice(0, limit) : all;
  }
  async findIdle(idleMs: number, now: number) {
    return this.registry.findIdle(idleMs, now);
  }
  async rememberPartner(userId: string, partnerId: string, now: number) {
    this.registry.rememberPartner(userId, partnerId, now);
  }
  async recentPartnersOf(userId: string) {
    return this.registry.recentPartnersOf(userId);
  }
  async sweepRecent(maxAgeMs: number, now: number) {
    return this.registry.sweepRecent(maxAgeMs, now);
  }
  async clear() {
    this.registry.clear();
  }

  raw(): PairingRegistry {
    return this.registry;
  }
}

class MemoryQueueStore implements QueueStore {
  private premium = new FifoQueue<QueueEntry>((e) => e.userId);
  private standard = new FifoQueue<QueueEntry>((e) => e.userId);

  private laneFor(entry: QueueEntry) {
    return entry.isPremium ? this.premium : this.standard;
  }

  private otherLaneFor(entry: QueueEntry) {
    return entry.isPremium ? this.standard : this.premium;
  }

  async enqueue(entry: QueueEntry) {
    // Only clear the *other* lane, in case premium status changed. Removing
    // from the target lane first would push a re-joining user to the tail and
    // cost them the time they had already waited — `FifoQueue.enqueue` updates
    // in place precisely to avoid that.
    this.otherLaneFor(entry).remove(entry.userId);
    this.laneFor(entry).enqueue(entry);
  }

  /**
   * Ordered oldest-first by `joinedAt`, not by insertion order.
   *
   * The linked list is insertion-ordered, which is the same thing whenever
   * arrivals are monotonic — but not when an entry is re-queued with an older
   * timestamp (the survivor of a failed match keeps its original `joinedAt`).
   * Redis orders by score, so sorting here is what keeps the two backends
   * behaviourally identical; wait time, not arrival order, is the thing the
   * FIFO guarantee is actually about.
   */
  private ordered(lane: FifoQueue<QueueEntry>): QueueEntry[] {
    return lane.toArray().sort((a, b) => a.joinedAt - b.joinedAt);
  }
  async remove(userId: string) {
    return this.premium.remove(userId) ?? this.standard.remove(userId);
  }
  async has(userId: string) {
    return this.premium.has(userId) || this.standard.has(userId);
  }
  async get(userId: string) {
    return this.premium.get(userId) ?? this.standard.get(userId);
  }
  async snapshot() {
    return { premium: this.ordered(this.premium), standard: this.ordered(this.standard) };
  }
  async size() {
    return this.premium.size + this.standard.size;
  }
  async laneSizes() {
    return { premium: this.premium.size, standard: this.standard.size };
  }
  async positionOf(userId: string) {
    // Ranked by wait time, matching `snapshot`.
    const p = this.ordered(this.premium).findIndex((e) => e.userId === userId);
    if (p >= 0) return p + 1;
    const s = this.ordered(this.standard).findIndex((e) => e.userId === userId);
    if (s >= 0) return this.premium.size + s + 1;
    return -1;
  }
  async oldestWaitMs(now: number) {
    let oldest = 0;
    const check = (e: QueueEntry) => {
      const waited = now - e.joinedAt;
      if (waited > oldest) oldest = waited;
    };
    this.premium.scan(check);
    this.standard.scan(check);
    return oldest;
  }
  async clear() {
    this.premium.clear();
    this.standard.clear();
  }

  /** No lock needed: the runtime is already the mutual-exclusion mechanism. */
  async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    return fn();
  }
}

class MemoryBus implements StoreBus {
  private emitter = new EventEmitter();

  constructor() {
    // One listener per channel per socket handler; the default cap of 10 is
    // far too low for a busy instance and only produces noise.
    this.emitter.setMaxListeners(0);
  }

  async publish(channel: string, message: unknown) {
    // Deliver asynchronously so publish/subscribe semantics match Redis, where
    // a publisher never runs its own subscriber synchronously.
    setImmediate(() => this.emitter.emit(channel, message));
  }
  async subscribe(channel: string, handler: (message: unknown) => void) {
    this.emitter.on(channel, handler);
  }
  async close() {
    this.emitter.removeAllListeners();
  }
}

export class MemoryStores implements Stores {
  readonly kind = "memory" as const;
  presence = new MemoryPresenceStore();
  pairing = new MemoryPairingStore();
  queue = new MemoryQueueStore();
  bus = new MemoryBus();

  async ping() {
    return true;
  }

  async close() {
    await this.bus.close();
    await this.presence.clear();
    await this.pairing.clear();
    await this.queue.clear();
  }
}
