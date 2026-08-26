import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { JWTPayload } from "../types";
import { prisma } from "../config/database";
import { asyncRoute } from "../utils/asyncRoute";
import { isShutOut } from "../services/ban";

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

/**
 * Who is asking, and whether they are still allowed to ask.
 *
 * The token settles the first question on its own. The second needs the
 * account, because a token lasts seven days and says nothing about what has
 * happened since it was issued -- somebody banned an hour ago still holds a
 * perfectly valid one.
 *
 * Folded in here rather than added to the routes that seemed to matter. That
 * list was already being kept by hand and already had a hole in it: the ban
 * was enforced on the socket alone, so it stopped the calls and left signing
 * in, buying coins and reporting other people open. A rule applied at the door
 * everything comes through cannot be forgotten on the way in.
 *
 * Costs one query per authenticated request. These routes are profile, wallet
 * and orders, none of which is hit in a loop; the busy path is the socket,
 * which asks once per connection rather than once per event.
 */
export const authenticate = asyncRoute(async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  const token = authHeader.split(" ")[1];

  let decoded: JWTPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  if (await isShutOut(decoded.userId)) {
    res.status(403).json({ error: "This account has been suspended." });
    return;
  }

  req.user = decoded;
  next();
});

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
 *
 * Wrapped, because it awaits: a database that is down would otherwise reject
 * with nobody listening, and the request would hang rather than fail. Failing
 * closed matters more here than anywhere else in the app.
 */
export const requireAdmin = asyncRoute(async function requireAdmin(
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

  /*
   * Compared exactly, not lowercased first.
   *
   * Lowercasing here was the escalation. Addresses were stored as typed and
   * Postgres compares by bytes, so the uppercase spelling of the
   * administrator's address was an ordinary separate account — and this line
   * folded it into a match, handing over the review queue: the power to
   * approve payments and credit any balance. The address is on the contact
   * page, so knowing it was never the obstacle.
   *
   * Addresses are normalised on the way in now, so a real account already
   * arrives lowercase and this comparison is exact for everyone entitled to
   * pass it. Anything still carrying capitals did not come through the front
   * door, which is reason enough to refuse it.
   */
  if (!user || !env.ADMIN_EMAILS.includes(user.email)) {
    res.status(403).json({ error: "Not permitted" });
    return;
  }

  next();
});
