/**
 * Run a promise you are not going to await, without letting it kill the
 * process.
 *
 * `void somePromise()` discards the promise entirely, so a rejection has no
 * handler and Node exits — which for a chat server means every call in
 * progress drops because one background sweep hit a closed socket. Wrapping a
 * `void` call in try/catch does not help either: the catch runs synchronously
 * and the rejection arrives later.
 *
 * This was not theoretical. Stopping Redis took the whole API down, health
 * endpoint included, via an ioredis MaxRetriesPerRequestError that nothing was
 * listening for.
 */
export function detach(promise: Promise<unknown>, context: string): void {
  promise.catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${context}]`, message);
  });
}
