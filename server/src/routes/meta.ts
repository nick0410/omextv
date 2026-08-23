import { Router, Request, Response } from "express";
import { prisma } from "../config/database";
import { COUNTRY_CODES } from "../config/countries";
import { authenticate } from "../middleware/auth";
import { genderService } from "../services/gender/service";
import { genderVerifySchema } from "../utils/validation";
import { stores } from "../services/store";
import { explainIncompatibility, stageFor } from "../services/matchmaking/engine";
import crypto from "crypto";

const router = Router();

/** GET /api/meta/countries — the codes the filter will accept. */
router.get("/countries", (_req: Request, res: Response) => {
  res.json({ countries: COUNTRY_CODES });
});

/**
 * GET /api/meta/countries/online
 *
 * Which countries currently have someone online, so the client can grey out
 * filters that would guarantee an empty queue.
 */
router.get("/countries/online", async (_req: Request, res: Response) => {
  try {
    // Must read the same store the socket layer writes to. This used to read a
    // legacy in-process singleton that nothing populates any more, so every
    // country reported zero online and the "nobody is there" hint never fired.
    const ids = await stores().presence.onlineUserIds();
    if (ids.length === 0) {
      res.json({ countries: [] });
      return;
    }

    const rows = await prisma.user.groupBy({
      by: ["country"],
      where: { id: { in: ids }, country: { not: null } },
      _count: { country: true },
    });

    res.json({
      countries: rows
        .filter((r) => r.country)
        .map((r) => ({ country: r.country as string, online: r._count.country }))
        .sort((a, b) => b.online - a.online),
    });
  } catch (err) {
    console.error("Online countries error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/meta/queue-report
 *
 * Why the people currently waiting are not being paired.
 *
 * Matchmaking failures are silent by design — the queue simply does not
 * produce a match — and the cause is nearly always a filter, enforced in both
 * directions, that one of the two people forgot they set. Without this, the
 * only way to find out was to guess.
 *
 * Authenticated, and identifies people only by a short hash of their id: the
 * point is to explain the rules, not to publish who is looking for whom.
 */
router.get("/queue-report", authenticate, async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    const { premium, standard } = await stores().queue.snapshot();
    const all = [...premium, ...standard];

    const short = (id: string) =>
      crypto.createHash("sha256").update(id).digest("hex").slice(0, 6);

    const entries = all.map((e) => ({
      id: short(e.userId),
      country: e.country,
      city: e.city,
      gender: e.effectiveGender,
      filters: e.filters,
      waitedMs: now - e.joinedAt,
      stage: stageFor(now - e.joinedAt),
    }));

    const pairs: { a: string; b: string; blockedBy: string | null }[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const stage = Math.max(
          stageFor(now - all[i].joinedAt),
          stageFor(now - all[j].joinedAt),
        );
        pairs.push({
          a: short(all[i].userId),
          b: short(all[j].userId),
          blockedBy: explainIncompatibility(all[i], all[j], stage, now),
        });
      }
    }

    res.json({ waiting: entries.length, entries, pairs });
  } catch (err) {
    console.error("Queue report error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/meta/verify-gender
 *
 * HTTP twin of the `verify-gender` socket event, for clients that would rather
 * verify before opening a socket.
 */
router.post("/verify-gender", authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = genderVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "An image is required", outcome: "invalid_image" });
      return;
    }

    const result = await genderService.verify(req.user!.userId, parsed.data.frames);

    const status =
      result.outcome === "accepted"
        ? 200
        : result.outcome === "rate_limited"
          ? 429
          : result.outcome === "provider_unavailable"
            ? 503
            : 422;

    if (result.outcome === "rate_limited" && result.retryAfterMs) {
      res.setHeader("Retry-After", Math.ceil(result.retryAfterMs / 1000));
    }

    res.status(status).json({
      ok: result.outcome === "accepted",
      outcome: result.outcome,
      gender: result.gender,
      confidence: result.confidence,
      mismatch: result.mismatch,
      framesUsed: result.framesUsed,
      agreement: result.agreement,
    });
  } catch (err) {
    console.error("Verify gender error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** GET /api/meta/gender-status — the caller's current verification state. */
router.get("/gender-status", authenticate, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        gender: true,
        verifiedGender: true,
        genderConfidence: true,
        genderVerifiedAt: true,
        genderMismatch: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { effectiveGender, verified } = genderService.resolveEffectiveGender(user);

    res.json({
      declared: user.gender,
      verified: user.verifiedGender,
      confidence: user.genderConfidence,
      verifiedAt: user.genderVerifiedAt,
      isFresh: genderService.isFresh(user.genderVerifiedAt),
      mismatch: user.genderMismatch,
      effectiveGender,
      usingVerified: verified,
      provider: genderService.getProviderName(),
    });
  } catch (err) {
    console.error("Gender status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
