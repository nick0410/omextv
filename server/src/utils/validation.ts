import { z } from "zod";
import { normalizeCountry, normalizeCountryList } from "../config/countries";
import { MatchFilters, DEFAULT_FILTERS } from "../types";

const usernameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters")
  .max(20, "Username must be at most 20 characters")
  .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores");

const countrySchema = z
  .string()
  .refine((v) => normalizeCountry(v) !== null, "Must be a valid ISO 3166-1 alpha-2 country code")
  .transform((v) => normalizeCountry(v)!);

const citySchema = z.string().trim().min(1).max(85); // longest real place name is 85 chars

export const registerSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200, "Password must be at most 200 characters"),
  username: usernameSchema,
  gender: z.enum(["male", "female", "other"]),
  country: countrySchema.optional(),
  city: citySchema.optional(),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

export const reportSchema = z.object({
  reportedId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  category: z
    .enum(["nudity", "harassment", "minor", "spam", "violence", "other"])
    .default("other"),
  reason: z
    .string()
    .min(10, "Reason must be at least 10 characters")
    .max(500, "Reason must be at most 500 characters"),
});

export const blockSchema = z.object({
  blockedId: z.string().min(1),
});

export const updateProfileSchema = z.object({
  username: usernameSchema.optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
  country: countrySchema.nullable().optional(),
  city: citySchema.nullable().optional(),
});

/**
 * Match filters arriving over the socket.
 *
 * Everything is coerced rather than rejected where a sane reading exists — a
 * dropped filter is a much better failure than a socket error mid-session —
 * except values that would silently change *who* the user meets, which must
 * never be guessed at.
 */
export const matchFiltersSchema = z.object({
  gender: z.enum(["any", "male", "female", "other"]).catch("any"),
  countries: z.array(z.string()).max(50).catch([]),
  city: z.string().trim().min(1).max(85).nullish().catch(null),
});

export function parseMatchFilters(input: unknown): MatchFilters {
  if (input === undefined || input === null) return { ...DEFAULT_FILTERS };

  const parsed = matchFiltersSchema.safeParse(input);
  if (!parsed.success) return { ...DEFAULT_FILTERS };

  const countries = normalizeCountryList(parsed.data.countries);

  // A city filter only means something inside a single country. With zero or
  // several countries selected, "Springfield" is ambiguous — drop it rather
  // than match the wrong one.
  const city = countries.length === 1 ? (parsed.data.city ?? null) : null;

  return { gender: parsed.data.gender, countries, city };
}

/**
 * Gender verification payload.
 *
 * Accepts a batch of frames (`images`) or a single one (`image`). Several
 * frames are strongly preferred — one webcam still is a noisy sample and
 * produces verdicts that flip between attempts.
 */
export const genderVerifySchema = z
  .object({
    image: z.string().min(1).max(4_000_000).optional(),
    images: z.array(z.string().min(1).max(4_000_000)).min(1).max(10).optional(),
  })
  .refine((v) => v.image || v.images, { message: "An image is required" })
  .transform((v) => ({ frames: v.images ?? [v.image!] }));
