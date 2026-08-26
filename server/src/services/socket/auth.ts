import { Socket } from "socket.io";
import jwt from "jsonwebtoken";

import { env } from "../../config/env";
import { prisma } from "../../config/database";
import { Gender, InferredGender, JWTPayload } from "../../types";
import { banStatus, clearExpiredBan } from "../ban";
import { AuthedSocket } from "./context";

/**
 * Deciding who is on the other end, before anything else runs.
 */

export async function authMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string" || token.length === 0) {
    return next(new Error("Authentication required"));
  }

  let decoded: JWTPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
  } catch {
    return next(new Error("Invalid or expired token"));
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        username: true,
        gender: true,
        verifiedGender: true,
        genderConfidence: true,
        genderVerifiedAt: true,
        isPremium: true,
        premiumExpiry: true,
        country: true,
        city: true,
        isBanned: true,
        bannedUntil: true,
      },
    });

    if (!user) return next(new Error("User not found"));

    // A ban that has expired should not keep anyone out. The rule lives in
    // services/ban so the HTTP side applies exactly the same one.
    const now = Date.now();
    const ban = banStatus(user, now);
    if (ban === "active") return next(new Error("Account suspended"));
    if (ban === "expired") await clearExpiredBan(user.id);

    // Likewise, premium that lapsed must not keep granting priority.
    const premiumActive =
      user.isPremium && (!user.premiumExpiry || user.premiumExpiry.getTime() > now);

    (socket as AuthedSocket).user = {
      id: user.id,
      username: user.username,
      gender: user.gender as Gender,
      verifiedGender: (user.verifiedGender as InferredGender | null) ?? null,
      genderConfidence: user.genderConfidence,
      genderVerifiedAt: user.genderVerifiedAt,
      isPremium: premiumActive,
      country: user.country,
      city: user.city,
    };
    next();
  } catch (err) {
    console.error("[socket] auth lookup failed:", err);
    next(new Error("Authentication failed"));
  }
}
