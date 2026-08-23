import { Router, Request, Response } from "express";
import { prisma } from "../config/database";
import { hashPassword, comparePassword, generateToken } from "../utils/auth";
import { registerSchema, loginSchema } from "../utils/validation";
import { authenticate } from "../middleware/auth";
import { loginLimiter, registerLimiter } from "../middleware/rateLimit";

const router = Router();

// POST /api/auth/register
router.post("/register", registerLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const { email, password, username, gender, country, city } = parsed.data;

    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });

    if (existingUser) {
      const field = existingUser.email === email ? "Email" : "Username";
      res.status(409).json({ error: `${field} already taken` });
      return;
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: { email, passwordHash, username, gender, country, city },
      select: {
        id: true,
        email: true,
        username: true,
        gender: true,
        isPremium: true,
        country: true,
        city: true,
        createdAt: true,
      },
    });

    const token = generateToken({ userId: user.id, email: user.email });

    res.status(201).json({ user, token });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/auth/login
router.post("/login", loginLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0].message });
      return;
    }

    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const isValid = await comparePassword(password, user.passwordHash);
    if (!isValid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = generateToken({ userId: user.id, email: user.email });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        gender: user.gender,
        isPremium: user.isPremium,
        country: user.country,
        city: user.city,
        createdAt: user.createdAt,
      },
      token,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/auth/me
router.get("/me", authenticate, async (req: Request, res: Response) => {
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
    console.error("Me error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
