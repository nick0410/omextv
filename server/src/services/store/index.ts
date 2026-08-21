import { env } from "../../config/env";
import { Stores } from "./types";
import { MemoryStores } from "./memory";

export * from "./types";
export { MemoryStores } from "./memory";
export { RedisStores } from "./redis";

let active: Stores = new MemoryStores();

export function stores(): Stores {
  return active;
}

/**
 * Choose the backing store.
 *
 * Redis is required for more than one instance; without it each node keeps its
 * own queue and two users on different nodes can never meet. With a single
 * instance the in-memory store is both simpler and faster, so it stays the
 * default.
 *
 * If Redis is configured but unreachable we fail loudly rather than silently
 * falling back — a cluster quietly splitting into isolated islands is a much
 * worse failure than refusing to boot.
 */
export async function initStores(): Promise<Stores> {
  if (!env.REDIS_URL) {
    active = new MemoryStores();
    return active;
  }

  const { RedisStores } = await import("./redis");
  const redis = new RedisStores(env.REDIS_URL);

  const alive = await redis.ping();
  if (!alive) {
    await redis.close();
    throw new Error(
      `REDIS_URL is set but Redis is unreachable at ${env.REDIS_URL}. ` +
        `Start Redis, or unset REDIS_URL to run single-instance.`,
    );
  }

  active = redis;
  return active;
}

/** Swap the store, for tests. */
export function setStores(next: Stores): void {
  active = next;
}

export async function closeStores(): Promise<void> {
  await active.close();
  active = new MemoryStores();
}
