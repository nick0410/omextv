/**
 * Does the administrator gate actually let the configured address in?
 *
 * Two things have to agree: the address in .env, and the address as Postgres
 * stored it. The gate compares them exactly, so a row written before addresses
 * were normalised can be configured as administrator and still be refused.
 */
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const configured = (process.env.ADMIN_EMAILS ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

console.log("configured:", configured);

for (const email of configured) {
  const rows = await p.user.findMany({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, username: true, isPremium: true, coins: true },
  });

  if (rows.length === 0) {
    console.log(`  ${email}  -> NO ACCOUNT with that address`);
    continue;
  }
  for (const r of rows) {
    const exact = r.email === email;
    console.log(`  stored "${r.email}" user=${r.username} coins=${r.coins} -> ${exact ? "ADMIN OK" : "REFUSED (casing differs)"}`);
  }
}
await p.$disconnect();
