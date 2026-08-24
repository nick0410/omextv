import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { JWTPayload } from "../types";
import { prisma } from "../config/database";

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    next();
    return;
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
    req.user = decoded;
  } catch {
    // Token invalid, proceed without user
  }
  next();
}

/**
 * Gate for the handful of endpoints that hand out coins.
 *
 * Deliberately reads the email from the database rather than from the token.
 * A JWT lasts seven days and carries whatever the email was when it was
 * issued, so a token minted before an address changed would keep working —
 * and this is the check standing between a stranger and the ability to credit
 * themselves any balance they like. Costs one query on a route nobody hits in
 * a loop.
 *
 * Runs after `authenticate`, which has already established who is asking.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  // An empty ADMIN_EMAILS must not mean "everyone". It means the approval
  // queue is unusable until someone is named, which is the safe direction.
  if (env.ADMIN_EMAILS.length === 0) {
    res.status(403).json({ error: "No administrators are configured" });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { email: true },
  });

  if (!user || !env.ADMIN_EMAILS.includes(user.email.toLowerCase())) {
    res.status(403).json({ error: "Not permitted" });
    return;
  }

  next();
}
