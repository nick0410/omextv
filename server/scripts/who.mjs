/**
 * Who has actually been here lately.
 *
 * Test accounts are excluded the same way the admin page excludes them: the
 * suite creates hundreds of them and they would drown out the handful of real
 * people. Anything ending .local or .test is ours, not a customer.
 */
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const real = { AND: [".local", ".test"].map((t) => ({ email: { not: { endsWith: t } } })) };
const ago = (d) => {
  if (!d) return "never";
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

const seen = await p.user.findMany({
  where: { AND: [real, { lastSeenAt: { not: null } }] },
  orderBy: { lastSeenAt: "desc" }, take: 10,
  select: { email: true, username: true, gender: true, coins: true, isPremium: true, lastSeenAt: true, createdAt: true },
});

console.log("=== last seen ===");
for (const u of seen) {
  const isNew = new Date(u.createdAt) > new Date(Date.now() - 86400000);
  console.log(
    `${ago(u.lastSeenAt).padEnd(9)} ${u.username.padEnd(18)} ${u.email.padEnd(34)} ` +
    `${u.gender.padEnd(7)} coins=${String(u.coins).padEnd(5)}${u.isPremium ? "PREMIUM " : ""}` +
    `${isNew ? "  << signed up in the last 24h" : ""}`
  );
}

const fresh = await p.user.findMany({
  where: real, orderBy: { createdAt: "desc" }, take: 5,
  select: { email: true, username: true, createdAt: true },
});
console.log("\n=== newest accounts ===");
for (const u of fresh) console.log(`${ago(u.createdAt).padEnd(9)} ${u.username.padEnd(18)} ${u.email}`);

console.log("\nreal accounts total:", await p.user.count({ where: real }));
await p.$disconnect();
