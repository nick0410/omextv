import { prisma } from "../../config/database";
import { env } from "../../config/env";
import { genderService } from "../gender/service";
import { genderVerifySchema } from "../../utils/validation";
import { AuthedSocket, SocketUser } from "./context";

/**
 * Reading a gender off the camera, and deciding whether that reading still
 * counts.
 */

export async function onVerifyGender(
  socket: AuthedSocket,
  payload: unknown,
  ack?: (res: unknown) => void,
): Promise<void> {
  const user = socket.user;
  const respond = (res: unknown) => {
    if (typeof ack === "function") ack(res);
    socket.emit("gender-verified", res);
  };

  const parsed = genderVerifySchema.safeParse(payload);
  if (!parsed.success) {
    respond({ ok: false, outcome: "invalid_image" });
    return;
  }

  try {
    const result = await genderService.verify(user.id, parsed.data.frames);

    if (result.outcome === "accepted" && result.gender) {
      // Keep the in-memory socket user in step so the next join-queue uses it
      // without a database round-trip.
      user.verifiedGender = result.gender;
      user.genderConfidence = result.confidence;
      user.genderVerifiedAt = new Date();
    }

    respond({
      ok: result.outcome === "accepted",
      outcome: result.outcome,
      gender: result.gender,
      confidence: result.confidence,
      mismatch: result.mismatch,
      retryAfterMs: result.retryAfterMs,
      framesUsed: result.framesUsed,
      agreement: result.agreement,
    });
  } catch (err) {
    console.error("[socket] gender verification failed:", err);
    respond({ ok: false, outcome: "provider_unavailable" });
  }
}

export function isGenderVerified(user: SocketUser): boolean {
  return genderService.resolveEffectiveGender(user).verified;
}
