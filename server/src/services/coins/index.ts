import { CoinService } from "./service";
import { createPrismaCoinStore } from "./adapters/prisma";
import { UpiPaymentProvider } from "./providers/upiProvider";

/**
 * Where the coin system is wired together.
 *
 * One place picks the implementations, so everything else names only the
 * interfaces — the same arrangement `services/store` uses to choose between
 * Redis and memory. Swapping the payment provider, or pointing the service at
 * a different database, is an edit here and nowhere else.
 */

let instance: CoinService | null = null;

export function coins(): CoinService {
  if (!instance) {
    instance = new CoinService(createPrismaCoinStore(), new UpiPaymentProvider());
  }
  return instance;
}

/** Replace the wired instance. Tests use this to inject in-memory backings. */
export function setCoinService(service: CoinService | null): void {
  instance = service;
}

export { CoinService } from "./service";
export * from "./ports";
