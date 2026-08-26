import { Router, Request, Response } from "express";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { authenticate, requireAdmin } from "../middleware/auth";
import { asyncRoute } from "../utils/asyncRoute";
import { stores } from "../services/store";
import { genderService } from "../services/gender/service";
import * as matcher from "../services/matchmaking/matcher";
import { paymentProvider } from "../services/coins";
import { RazorpayPaymentProvider } from "../services/coins/providers/razorpayProvider";
import { isUpiConfigured } from "../services/coins/upi";

const router = Router();

/**
 * One request that answers "is this working for customers right now".
 *
 * Built around a list of problems rather than a wall of numbers. Numbers
 * require someone to know what normal looks like at two in the morning; a line
 * saying "calls between different networks will fail, no TURN relay" does not.
 * The counts are there underneath for when the answer is not obvious.
 *
 * Every check here is something that has actually gone wrong on this
 * deployment at least once.
 */

export type Level = "broken" | "degraded" | "note";

export interface Problem {
  level: Level;
  what: string;
  why: string;
  fix: string;
}

/** Bounded, so a dead dependency cannot make the page that reports it hang. */
async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Domains that cannot belong to a real person.
 *
 * .test is reserved by RFC 6761 and .local is mDNS; neither can receive mail,
 * so nothing under them is ever a customer. Every test script in this repo
 * creates accounts there — probe.local, smoke.local, t.local, local.test.
 *
 * They were being counted as users. The dashboard read "452 accounts, 134 new
 * today" when five were people and the rest were this project testing itself,
 * which makes it a report on the test suite rather than on the business — and
 * the kind of number someone makes a decision on.
 *
 * A rule rather than a list of known prefixes: a new script inventing its own
 * fake domain is still excluded, as long as it stays inside the reserved space
 * it should be using anyway.
 */
const SYNTHETIC_TLDS = [".local", ".test"];

/** Matches accounts that could belong to somebody. */
const realUser = {
  AND: SYNTHETIC_TLDS.map((tld) => ({ email: { not: { endsWith: tld } } })),
};

/** Matches the rest, so they can be shown rather than silently dropped. */
const syntheticUser = {
  OR: SYNTHETIC_TLDS.map((tld) => ({ email: { endsWith: tld } })),
};

router.get(
  "/overview",
  authenticate,
  requireAdmin,
  asyncRoute(async (_req: Request, res: Response) => {
    const now = Date.now();
    const store = stores();
    const provider = paymentProvider();
    const razorpay = provider instanceof RazorpayPaymentProvider ? provider : null;

    const [storeOk, dbOk] = await Promise.all([
      withTimeout(store.ping(), 3000, false),
      withTimeout(
        prisma.$queryRaw`SELECT 1`.then(() => true, () => false),
        3000,
        false,
      ),
    ]);

    // Everything below needs the database. Report what is known rather than
    // failing the whole page when it is down — that is exactly when someone is
    // looking at this.
    const empty = {
      users: { total: 0, today: 0, week: 0, premium: 0, banned: 0 },
      money: {
        grossPaise: 0,
        byStatus: {} as Record<string, number>,
        awaitingReview: 0,
        stale: 0,
        coinsOutstanding: 0,
      },
      chats: { today: 0, week: 0, reportsWeek: 0 },
      people: [] as unknown[],
      recentOrders: [] as unknown[],
    };

    const data = dbOk ? await loadFromDatabase(now) : empty;
    const live = await withTimeout(
      matcher.queueStats(),
      3000,
      { queued: 0, queuedPremium: 0, queuedStandard: 0, oldestWaitMs: 0 },
    );
    const [online, activeChats] = await Promise.all([
      withTimeout(store.presence.onlineCount(), 3000, 0),
      withTimeout(store.pairing.activeCount(), 3000, 0),
    ]);

    const payments = {
      provider: provider.id,
      configured: provider.isConfigured(),
      confirmsAutomatically: provider.confirmsAutomatically,
      mode: razorpay
        ? env.RAZORPAY_KEY_ID.startsWith("rzp_live_")
          ? "live"
          : env.RAZORPAY_KEY_ID.startsWith("rzp_test_")
            ? "test"
            : "unknown"
        : null,
      webhookReady: razorpay ? razorpay.canVerifyWebhooks() : null,
      upiConfigured: isUpiConfigured(),
      adminCount: env.ADMIN_EMAILS.length,
    };

    const calls = {
      hasTurn: Boolean(env.TURN_SERVER_URL || env.TURN_SECRET),
      stunCount: env.STUN_URLS.length,
      requiresVerification: env.REQUIRE_GENDER_VERIFICATION,
    };

    res.json({
      checkedAt: new Date(now).toISOString(),
      problems: findProblems({ storeOk, dbOk, payments, calls, money: data.money, live }),
      health: {
        storeOk,
        dbOk,
        store: store.kind,
        instance: env.INSTANCE_ID,
        version: "2.1.0",
        nodeEnv: env.NODE_ENV,
        uptimeSec: Math.round(process.uptime()),
        genderProvider: genderService.getProviderName(),
        genderReady: genderService.isReady(),
      },
      payments,
      calls,
      live: { online, activeChats, ...live },
      ...data,
    });
  }),
);

async function loadFromDatabase(now: number) {
  const dayAgo = new Date(now - DAY);
  const weekAgo = new Date(now - 7 * DAY);
  // An order nobody has finished in a day is not going to finish itself.
  const staleBefore = new Date(now - DAY);

  // A conversation counts only when both sides could be people.
  const realChat = { userA: realUser, userB: realUser };

  const [
    total,
    today,
    week,
    premium,
    banned,
    synthetic,
    orderGroups,
    approvedSum,
    coinSum,
    awaitingReview,
    stale,
    chatsToday,
    chatsWeek,
    reportsWeek,
    recent,
    people,
  ] = await Promise.all([
    prisma.user.count({ where: realUser }),
    prisma.user.count({ where: { AND: [realUser, { createdAt: { gte: dayAgo } }] } }),
    prisma.user.count({ where: { AND: [realUser, { createdAt: { gte: weekAgo } }] } }),
    prisma.user.count({
      where: { AND: [realUser, { isPremium: true, premiumExpiry: { gt: new Date(now) } }] },
    }),
    prisma.user.count({ where: { AND: [realUser, { isBanned: true }] } }),
    prisma.user.count({ where: syntheticUser }),
    prisma.coinOrder.groupBy({ by: ["status"], _count: { _all: true }, where: { user: realUser } }),
    prisma.coinOrder.aggregate({
      where: { status: "approved", user: realUser },
      _sum: { amountPaise: true },
    }),
    // What is owed to buyers: coins bought and not yet spent.
    prisma.user.aggregate({ where: realUser, _sum: { coins: true } }),
    prisma.coinOrder.count({ where: { status: "under_review", user: realUser } }),
    prisma.coinOrder.count({
      where: {
        status: { in: ["awaiting_payment", "under_review"] },
        createdAt: { lt: staleBefore },
        user: realUser,
      },
    }),
    prisma.chatSession.count({ where: { AND: [realChat, { startedAt: { gte: dayAgo } }] } }),
    prisma.chatSession.count({ where: { AND: [realChat, { startedAt: { gte: weekAgo } }] } }),
    prisma.report.count({ where: { AND: [{ reporter: realUser }, { createdAt: { gte: weekAgo } }] } }),
    prisma.coinOrder.findMany({
      where: { user: realUser },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { user: { select: { username: true, email: true } } },
    }),
    /*
     * Everyone who could be a customer, newest first.
     *
     * Counts say how many there are; they cannot say who, and with a handful
     * of real accounts the individuals are the interesting thing — who came
     * back, who signed up and never returned, who is carrying a balance.
     *
     * Capped rather than unbounded: this is one row per person today, and the
     * cap is what stops the page turning into a database dump the day it is
     * not.
     */
    prisma.user.findMany({
      where: realUser,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        username: true,
        email: true,
        gender: true,
        verifiedGender: true,
        country: true,
        coins: true,
        isPremium: true,
        premiumExpiry: true,
        isBanned: true,
        createdAt: true,
        lastSeenAt: true,
        _count: { select: { reportedBy: true } },
      },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of orderGroups) byStatus[row.status] = row._count._all;

  return {
    // `synthetic` is reported rather than hidden: a dashboard that quietly
    // drops rows is as misleading as one that quietly counts them.
    users: { total, today, week, premium, banned, synthetic },
    money: {
      grossPaise: approvedSum._sum.amountPaise ?? 0,
      byStatus,
      awaitingReview,
      stale,
      coinsOutstanding: coinSum._sum.coins ?? 0,
    },
    chats: { today: chatsToday, week: chatsWeek, reportsWeek },
    people: people.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      // Declared and detected are both shown: they disagreeing is the signal.
      gender: u.gender,
      verifiedGender: u.verifiedGender,
      country: u.country,
      coins: u.coins,
      // The stored flag lies the moment a pass lapses, so the date decides.
      isPremium: u.isPremium && (!u.premiumExpiry || u.premiumExpiry.getTime() > now),
      isBanned: u.isBanned,
      reportsAgainst: u._count.reportedBy,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
    })),
    recentOrders: recent.map((o) => ({
      id: o.id,
      username: o.user.username,
      email: o.user.email,
      amountPaise: o.amountPaise,
      coins: o.coins,
      status: o.status,
      paymentRef: o.upiRef,
      note: o.note,
      createdAt: o.createdAt.toISOString(),
    })),
  };
}

/**
 * What is wrong, in the order it would hurt a customer.
 *
 * Each of these has happened here. The wording says what a customer would
 * experience rather than what a log line said, because that is the thing worth
 * deciding on.
 */
export function findProblems(input: {
  storeOk: boolean;
  dbOk: boolean;
  payments: { provider: string; configured: boolean; mode: string | null; webhookReady: boolean | null; adminCount: number; confirmsAutomatically: boolean };
  calls: { hasTurn: boolean; stunCount: number };
  money: { awaitingReview: number; stale: number };
  live: { oldestWaitMs: number };
}): Problem[] {
  const out: Problem[] = [];
  const { payments, calls, money } = input;

  if (!input.dbOk) {
    out.push({
      level: "broken",
      what: "Nobody can sign in or sign up",
      why: "The database is not answering.",
      fix: "Start Postgres, then check scripts/status.ps1.",
    });
  }

  if (!input.storeOk) {
    out.push({
      level: "broken",
      what: "Matching is down",
      why: "The queue store is not answering, so nobody can be paired.",
      fix: "Start Redis on the port in REDIS_URL.",
    });
  }

  if (!payments.configured) {
    out.push({
      level: "broken",
      what: "Nobody can buy coins",
      why: `The ${payments.provider} provider is selected but not configured.`,
      fix:
        payments.provider === "razorpay"
          ? "Run scripts/set-razorpay.ps1 with your keys."
          : "Run scripts/set-upi.ps1 with your UPI id.",
    });
  }

  if (payments.mode === "test") {
    out.push({
      level: "broken",
      what: "Payments take no real money",
      why: "Razorpay is running on test keys, so a real customer pays nothing and gets nothing.",
      fix: "Switch to live keys once activation clears, or set PAYMENT_PROVIDER=upi meanwhile.",
    });
  }

  if (payments.mode === "live" && payments.webhookReady === false) {
    out.push({
      level: "degraded",
      what: "A customer who closes the tab is charged and gets nothing",
      why: "No webhook secret, so payments are only credited while the buyer stays on the page.",
      fix: "Set a webhook in the Razorpay dashboard and re-run scripts/set-razorpay.ps1.",
    });
  }

  if (payments.adminCount === 0) {
    out.push({
      level: "broken",
      what: "Payments can never be approved",
      why: "No administrator is configured, so the review queue is unusable.",
      fix: "Set ADMIN_EMAILS in server/.env to an account that exists.",
    });
  }

  if (!calls.hasTurn) {
    out.push({
      level: "degraded",
      what: "Calls between different networks fail",
      why:
        "No TURN relay. Two people on different mobile networks or campus Wi-Fi usually cannot " +
        "connect directly, and premium is what they paid for.",
      fix: "Run scripts/set-turn.ps1 with credentials from a TURN provider.",
    });
  }

  if (calls.stunCount === 0) {
    out.push({
      level: "broken",
      what: "Almost no calls will connect",
      why: "No STUN servers configured.",
      fix: "Set STUN_URLS in server/.env.",
    });
  }

  if (!payments.confirmsAutomatically && money.awaitingReview > 0) {
    out.push({
      level: "degraded",
      what: `${money.awaitingReview} customer${money.awaitingReview === 1 ? " is" : "s are"} waiting for coins`,
      why: "They have paid and said so; nothing credits them until you approve it.",
      fix: "Open the payments queue and check each against your bank statement.",
    });
  }

  if (money.stale > 0) {
    out.push({
      level: "note",
      what: `${money.stale} order${money.stale === 1 ? " is" : "s are"} older than a day and unfinished`,
      why: "Usually someone who changed their mind, but it can be a payment nobody claimed.",
      fix: "Worth a look in the orders list below.",
    });
  }

  // Ten minutes without a match, with people waiting, is a filter nobody can
  // satisfy rather than a quiet night.
  if (input.live.oldestWaitMs > 10 * 60_000) {
    out.push({
      level: "note",
      what: "Someone has been waiting more than ten minutes",
      why: "Either nobody else is online, or their filters cannot be matched.",
      fix: "Check the queue report at /api/meta/queue-report.",
    });
  }

  return out;
}

export default router;
