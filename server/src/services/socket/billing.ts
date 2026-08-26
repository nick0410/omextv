import { coins } from "../coins";
import {
  CALL_CHARGE_AFTER_MS,
  CALL_CHARGE_COINS,
  owesForCall,
} from "../coins/callCharge";
import { detach } from "../../utils/detach";
import { MatchResult, QueueEntry } from "../../types";
import { callChargeTimers, pendingCallCharges } from "./context";
import { emitToUser } from "./delivery";

/**
 * Charging for a call that somebody chose, once it has really happened.
 *
 * The rules about who owes live in services/coins/callCharge. This is only the
 * timing: when to ask, and how to stop asking.
 */

/** Stop a pending charge, for a call that did not last. */
export function cancelCallCharge(roomId: string): void {
  pendingCallCharges.delete(roomId);
  const timer = callChargeTimers.get(roomId);
  if (!timer) return;
  clearTimeout(timer);
  callChargeTimers.delete(roomId);
}

/**
 * Note who will owe for this call, without starting the clock.
 *
 * Being matched is not being in a call. The two ends still have to find each
 * other, and when they cannot — no relay configured, one of them behind a
 * network that will not hole-punch — the room exists, both people sit looking
 * at a black rectangle, and nothing about that is worth fifty coins.
 *
 * The clock starts from `markCallConnected`, so what is billed is time spent
 * actually talking rather than time spent since a pairing was written down.
 */
export function scheduleCallCharge(match: MatchResult): void {
  const owing = [
    owesForCall(match.a, match.b) ? match.a : null,
    owesForCall(match.b, match.a) ? match.b : null,
  ].filter(Boolean) as QueueEntry[];

  if (owing.length === 0) return;

  pendingCallCharges.set(match.roomId, {
    owing: owing.map((entry) => ({ userId: entry.userId })),
    started: false,
  });
}

/**
 * The call is up: start the clock that decides whether it is billable.
 *
 * Reported by the client when ICE reaches a connected state, which is the
 * first moment either end can know media has a path. Both ends report, and a
 * reconnect reports again, so this is deliberately once-only per room — a
 * second clock against the same call would charge twice.
 *
 * Scheduled rather than charged at teardown so the price is paid at the moment
 * the threshold passes. Charging on teardown would mean a call the server
 * never sees end — a crash, a lost socket — is free, and would also let
 * somebody hang up at fourteen seconds forever.
 */
export function markCallConnected(roomId: string): void {
  const pending = pendingCallCharges.get(roomId);
  if (!pending || pending.started) return;
  pending.started = true;

  const timer = setTimeout(() => {
    callChargeTimers.delete(roomId);
    pendingCallCharges.delete(roomId);

    for (const entry of pending.owing) {
      detach(
        (async () => {
          const paid = await coins().chargeForCall(
            entry.userId,
            CALL_CHARGE_COINS,
            roomId,
          );
          // Not an error. A balance spent elsewhere since the match was made
          // means the call goes on unpaid rather than being interrupted.
          if (!paid) return;

          await emitToUser(entry.userId, "coins-charged", {
            amount: CALL_CHARGE_COINS,
            reason: "call",
            roomId,
          });
        })(),
        "socket:call-charge",
      );
    }
  }, CALL_CHARGE_AFTER_MS);

  timer.unref?.();
  callChargeTimers.set(roomId, timer);
}
