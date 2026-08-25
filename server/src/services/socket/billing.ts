import { coins } from "../coins";
import {
  CALL_CHARGE_AFTER_MS,
  CALL_CHARGE_COINS,
  owesForCall,
} from "../coins/callCharge";
import { detach } from "../../utils/detach";
import { MatchResult, QueueEntry } from "../../types";
import { callChargeTimers } from "./context";
import { emitToUser } from "./delivery";

/**
 * Charging for a call that somebody chose, once it has lasted long enough.
 *
 * The rules about who owes live in services/coins/callCharge. This is only the
 * timing: when to ask, and how to stop asking.
 */

/** Stop a pending charge, for a call that did not last. */
export function cancelCallCharge(roomId: string): void {
  const timer = callChargeTimers.get(roomId);
  if (!timer) return;
  clearTimeout(timer);
  callChargeTimers.delete(roomId);
}

/**
 * Bill whoever chose, once the call has run long enough to count.
 *
 * Scheduled rather than charged at teardown so the price is paid at the moment
 * the threshold passes. Charging on teardown would mean a call the server
 * never sees end — a crash, a lost socket — is free, and would also let
 * somebody hang up at fourteen seconds forever.
 */
export function scheduleCallCharge(match: MatchResult): void {
  const owing = [
    owesForCall(match.a, match.b) ? match.a : null,
    owesForCall(match.b, match.a) ? match.b : null,
  ].filter(Boolean) as QueueEntry[];

  if (owing.length === 0) return;

  const timer = setTimeout(() => {
    callChargeTimers.delete(match.roomId);
    for (const entry of owing) {
      detach(
        (async () => {
          const paid = await coins().chargeForCall(
            entry.userId,
            CALL_CHARGE_COINS,
            match.roomId,
          );
          // Not an error. A balance spent elsewhere since the match was made
          // means the call goes on unpaid rather than being interrupted.
          if (!paid) return;

          await emitToUser(entry.userId, "coins-charged", {
            amount: CALL_CHARGE_COINS,
            reason: "call",
            roomId: match.roomId,
          });
        })(),
        "socket:call-charge",
      );
    }
  }, CALL_CHARGE_AFTER_MS);

  timer.unref?.();
  callChargeTimers.set(match.roomId, timer);
}
