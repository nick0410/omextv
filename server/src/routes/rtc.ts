import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { buildIceConfig } from "../services/turn";

const router = Router();

/**
 * GET /api/rtc/ice-servers
 *
 * Authenticated because the credentials are scoped to the calling user and are
 * a billable resource — handing out relay access anonymously means paying for
 * strangers' bandwidth.
 */
router.get("/ice-servers", authenticate, (req: Request, res: Response) => {
  const config = buildIceConfig(req.user!.userId);

  // Ephemeral credentials must not be cached by an intermediary and reused
  // past their expiry.
  res.setHeader("Cache-Control", "no-store");
  res.json(config);
});

export default router;
