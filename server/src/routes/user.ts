import { Router, Request, Response } from "express";
import { prisma } from "../config/database";
import { authenticate } from "../middleware/auth";
import { updateProfileSchema } from "../utils/validation";

const router = Router();

// GET /api/user/profile
router.get("/profile", authenticate, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        username: true,
        gender: true,
        isPremium: true,
        premiumExpiry: true,
        country: true,
        city: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ user });
  } catch (err) {
    console.error("Profile error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/user/profile
router.patch("/profile", authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const { username, gender, country, city } = parsed.data;

    if (username) {
      const existing = await prisma.user.findFirst({
        where: { username, NOT: { id: req.user!.userId } },
      });
      if (existing) {
        res.status(409).json({ error: "Username already taken" });
        return;
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        ...(username && { username }),
        ...(gender && { gender }),
        ...(country !== undefined && { country }),
        ...(city !== undefined && { city }),
      },
      select: {
        id: true,
        email: true,
        username: true,
        gender: true,
        isPremium: true,
        premiumExpiry: true,
        country: true,
        city: true,
        createdAt: true,
      },
    });

    res.json({ user });
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
