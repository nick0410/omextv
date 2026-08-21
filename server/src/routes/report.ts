import { Router, Request, Response } from "express";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { authenticate } from "../middleware/auth";
import { reportSchema, blockSchema } from "../utils/validation";
import { pairing } from "../services/pairing";

const router = Router();

/**
 * POST /api/report
 *
 * Reporting also ends the chat: a user who has just seen something they need
 * to report should not be left sitting in the room with that person while the
 * write happens.
 */
router.post("/", authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const reporterId = req.user!.userId;
    const { reportedId, reason, category, sessionId } = parsed.data;

    if (reportedId === reporterId) {
      res.status(400).json({ error: "You cannot report yourself" });
      return;
    }

    const reported = await prisma.user.findUnique({
      where: { id: reportedId },
      select: { id: true, reportCount: true },
    });
    if (!reported) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // A session id, when given, must be one the reporter actually took part in
    // — otherwise anyone could attach a report to an unrelated conversation.
    if (sessionId) {
      const session = await prisma.chatSession.findUnique({
        where: { id: sessionId },
        select: { userAId: true, userBId: true },
      });
      if (!session || (session.userAId !== reporterId && session.userBId !== reporterId)) {
        res.status(403).json({ error: "Not a participant in that session" });
        return;
      }
    }

    try {
      await prisma.report.create({
        data: { reporterId, reportedId, reason, category, sessionId: sessionId ?? null },
      });
    } catch (err: unknown) {
      // Unique(reporterId, sessionId): one report per person per conversation.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
        res.status(409).json({ error: "You have already reported this session" });
        return;
      }
      throw err;
    }

    const updated = await prisma.user.update({
      where: { id: reportedId },
      data: { reportCount: { increment: 1 } },
      select: { reportCount: true },
    });

    // Automatic temporary suspension once enough distinct reports land.
    let banned = false;
    if (
      env.AUTO_BAN_REPORT_THRESHOLD > 0 &&
      updated.reportCount >= env.AUTO_BAN_REPORT_THRESHOLD
    ) {
      await prisma.user.update({
        where: { id: reportedId },
        data: {
          isBanned: true,
          bannedUntil: new Date(Date.now() + env.AUTO_BAN_HOURS * 60 * 60_000),
          banReason: "Automatic suspension after multiple reports",
        },
      });
      banned = true;
    }

    const pair = pairing.pairOf(reporterId);
    res.status(201).json({ ok: true, chatEnded: pair !== null, actionTaken: banned });
  } catch (err) {
    console.error("Report error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** POST /api/report/block — never be matched with this person again. */
router.post("/block", authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = blockSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const blockerId = req.user!.userId;
    const { blockedId } = parsed.data;

    if (blockedId === blockerId) {
      res.status(400).json({ error: "You cannot block yourself" });
      return;
    }

    const target = await prisma.user.findUnique({
      where: { id: blockedId },
      select: { id: true },
    });
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Idempotent: blocking twice is a no-op, not a 409.
    await prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {},
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Block error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** DELETE /api/report/block/:id */
router.delete("/block/:id", authenticate, async (req: Request, res: Response) => {
  try {
    const blockerId = req.user!.userId;
    const blockedId = String(req.params.id);

    const deleted = await prisma.block.deleteMany({ where: { blockerId, blockedId } });
    res.json({ ok: true, removed: deleted.count });
  } catch (err) {
    console.error("Unblock error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** GET /api/report/blocks — who this user has blocked. */
router.get("/blocks", authenticate, async (req: Request, res: Response) => {
  try {
    const blocks = await prisma.block.findMany({
      where: { blockerId: req.user!.userId },
      select: {
        blockedId: true,
        createdAt: true,
        blocked: { select: { username: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    res.json({
      blocks: blocks.map((b) => ({
        userId: b.blockedId,
        username: b.blocked.username,
        createdAt: b.createdAt,
      })),
    });
  } catch (err) {
    console.error("List blocks error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
