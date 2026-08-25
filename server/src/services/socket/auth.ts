import { Socket } from "socket.io";
import jwt from "jsonwebtoken";

import { env } from "../../config/env";
import { prisma } from "../../config/database";
import { Gender, InferredGender, JWTPayload } from "../../types";
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

    // A ban that has expired should not keep anyone out.
    const now = Date.now();
    if (user.isBanned) {
      const stillBanned = !user.bannedUntil || user.bannedUntil.getTime() > now;
      if (stillBanned) return next(new Error("Account suspended"));
      await prisma.user.update({
        where: { id: user.id },
        data: { isBanned: false, bannedUntil: null },
      });
    }

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
