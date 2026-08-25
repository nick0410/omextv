import { env } from "../../config/env";
import * as matcher from "../matchmaking/matcher";
import { stores } from "../store";
import { persistSessionStart, loadBlockedIds, loadRecentPartners } from "../pairing";
import type { PairRecord } from "../store/types";
import { genderService } from "../gender/service";
import { parseMatchFilters } from "../../utils/validation";
import { applyEntitlement } from "../coins/entitlement";
import { coins } from "../coins";
import { MatchResult, QueueEntry } from "../../types";
import { AuthedSocket, getIo, queueLimiter } from "./context";
import { scheduleCallCharge } from "./billing";
import { liveSocketFor } from "./delivery";
import { livePairFor } from "./pairs";
import { isGenderVerified } from "./verification";

/**
 * Joining the queue, leaving it, and turning a chosen pair into a live room.
 */

export async function onJoinQueue(socket: AuthedSocket, payload: unknown): Promise<void> {
  const user = socket.user;

  const limit = queueLimiter.consume(user.id);
  if (!limit.allowed) {
    socket.emit("queue-error", {
      code: "rate_limited",
      message: "Too many queue requests. Slow down.",
      retryAfterMs: limit.retryAfterMs,
    });
    return;
  }

  // Cannot queue while genuinely talking to someone. A pair whose other side
  // has gone is cleared rather than used to refuse.
  if (await livePairFor(user.id)) {
    socket.emit("queue-error", {
      code: "already_in_chat",
      message: "You are already in a chat. Skip or end it first.",
    });
    return;
  }

  if (env.REQUIRE_GENDER_VERIFICATION && !isGenderVerified(user)) {
    socket.emit("queue-error", {
      code: "verification_required",
      message: "Camera verification is required before matching.",
    });
    return;
  }

  /*
   * Free accounts match anyone.
   *
   * Choosing a gender or a country is what premium sells, so the limit is
   * applied here, where the request actually takes effect, rather than in the
   * UI. The controls are disabled there too, but that is a courtesy: this
   * payload arrives over a socket and can be sent by hand.
   *
   * Clamped rather than refused — see applyEntitlement. The client is told
   * what was dropped so it can say so plainly instead of leaving someone to
   * wonder why they are meeting people they filtered out.
   */
  /*
   * Asked now, not remembered from the handshake.
   *
   * A socket authenticates once and can live for hours. Someone who buys a
   * pass mid-session would otherwise stay clamped to the free tier until they
   * happened to reconnect — they pay, pick a gender, and meet everyone anyway,
   * which is indistinguishable from the payment having failed. The same read
   * catches a pass that lapsed during the session, in the other direction.
   *
   * One primary-key lookup, on a path that is already rate limited per user.
   */
  user.isPremium = await coins().isPremiumNow(user.id);

  /*
   * The balance decides too, now that a gender filter can be paid for per
   * call rather than only by holding a pass. Read at the same moment as the
   * pass for the same reason: both change while a socket is open.
   */
  const wallet = await coins().walletFor(user.id);
  const balance = wallet?.coins ?? 0;

  const requested = parseMatchFilters(payload);
  const { filters, dropped } = applyEntitlement(requested, user.isPremium, balance);
  if (dropped.length > 0) {
    socket.emit("filters-restricted", {
      dropped,
      message:
        "Choosing who you meet is a premium feature. Searching everyone for now.",
    });
  }

  try {
    const entry = await buildQueueEntry(socket, filters);
    const match = await matcher.joinQueue(entry);

    if (match) {
      await establishMatch(match);
    } else {
      socket.emit("queue-joined", {
        position: await matcher.queuePosition(user.id),
        size: await matcher.queueSize(),
        filters,
      });
    }
  } catch (err) {
    console.error("[socket] join-queue failed:", err);
    await matcher.leaveQueue(user.id);
    socket.emit("queue-error", { code: "internal", message: "Failed to join the queue." });
  }
}

async function buildQueueEntry(socket: AuthedSocket, filters: QueueEntry["filters"]): Promise<QueueEntry> {
  const user = socket.user;

  // Loaded before the (synchronous) matching step, so the matcher never awaits.
  const [blockedIds, recentPartners] = await Promise.all([
    loadBlockedIds(user.id),
    loadRecentPartners(user.id, 30 * 60_000),
  ]);

  const { effectiveGender, verified } = genderService.resolveEffectiveGender(user);

  return {
    userId: user.id,
    socketId: socket.id,
    username: user.username,
    gender: user.gender,
    verifiedGender: user.verifiedGender,
    effectiveGender,
    genderIsVerified: verified,
    country: user.country,
    city: user.city,
    isPremium: user.isPremium,
    filters,
    blockedIds,
    recentPartners,
    joinedAt: Date.now(),
    relaxStage: 0,
  };
}

export async function onLeaveQueue(socket: AuthedSocket): Promise<void> {
  const removed = await matcher.leaveQueue(socket.user.id);
  socket.emit("queue-left", { wasQueued: removed !== null });
}

/**
 * Turn a match into a live room.
 *
 * Both sockets are re-resolved from the presence registry rather than trusted
 * from the queue entry: a user can disconnect between joining the queue and
 * being matched, and emitting into a dead socket would strand the other side
 * in a room with a ghost. If one side is gone, the survivor goes back to the
 * front of the queue instead of being told about a partner who is not there.
 */
export async function establishMatch(match: MatchResult, depth = 0): Promise<void> {
  const io = getIo();
  if (!io) return;

  const aSocket = await liveSocketFor(match.a.userId);
  const bSocket = await liveSocketFor(match.b.userId);

  if (!aSocket || !bSocket) {
    const survivor = aSocket ? match.a : bSocket ? match.b : null;
    const lost = aSocket ? match.b : match.a;
    await matcher.leaveQueue(lost.userId);

    if (survivor) {
      // Preserve the original joinedAt so they keep their place in line.
      const retry = await matcher.joinQueue(survivor);

      // Re-queuing can itself produce a match. Dropping it here would leave
      // both of those users dequeued and never told, waiting forever.
      // `depth` bounds the chain in case a whole run of queued sockets has
      // died, so one bad batch cannot recurse without end.
      if (retry) {
        if (depth < 10) {
          await establishMatch(retry, depth + 1);
        } else {
          console.error("[socket] establishMatch recursion cap hit; re-queueing both");
          await matcher.joinQueue(retry.a);
          await matcher.joinQueue(retry.b);
        }
        return;
      }

      (await liveSocketFor(survivor.userId))?.emit("queue-requeued", {
        reason: "partner_unavailable",
        position: await matcher.queuePosition(survivor.userId),
      });
    }
    return;
  }

  const now = Date.now();
  const pair: PairRecord = {
    roomId: match.roomId,
    userAId: match.a.userId,
    userBId: match.b.userId,
    startedAt: now,
    dbId: null,
    messageCount: 0,
    lastActivityAt: now,
  };

  // Write the ChatSession row *before* putting the pair in the store, so the
  // stored record already carries its dbId. Doing it the other way round left
  // the id only on this local object — the copy the teardown path reads back
  // still had null, so the session was never closed out in the database.
  await persistSessionStart(pair, match.matchedOn);
  await stores().pairing.create(pair);

  aSocket.join(match.roomId);
  bSocket.join(match.roomId);

  // Exactly one side creates the WebRTC offer, else both would and glare.
  aSocket.emit("match-found", {
    roomId: match.roomId,
    isInitiator: true,
    partner: publicProfile(match.b),
    waitedMs: match.matchedOn.aWaitedMs,
    relaxStage: match.stage,
  });

  bSocket.emit("match-found", {
    roomId: match.roomId,
    isInitiator: false,
    partner: publicProfile(match.a),
    waitedMs: match.matchedOn.bWaitedMs,
    relaxStage: match.stage,
  });

  scheduleCallCharge(match);
}

/** What the other person is allowed to learn about you. Never the email. */
function publicProfile(entry: QueueEntry) {
  return {
    userId: entry.userId,
    username: entry.username,
    gender: entry.effectiveGender,
    genderVerified: entry.genderIsVerified,
    country: entry.country,
    city: entry.city,
    isPremium: entry.isPremium,
  };
}
