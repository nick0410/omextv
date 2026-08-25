/**
 * Prove the administrator gate on the running server, not in theory.
 *
 * .env agreeing with the database proves nothing about the process that is
 * actually serving: it read its configuration at boot and has been up since.
 * So this signs in as the configured administrator and asks the real endpoint.
 *
 * The token is minted in memory and never printed.
 */
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const API = process.env.API ?? "http://localhost:3001";
const p = new PrismaClient();

const email = (process.env.ADMIN_EMAILS ?? "").split(",")[0].trim().toLowerCase();
const me = await p.user.findFirst({
  where: { email: { equals: email, mode: "insensitive" } },
  select: { id: true, email: true },
});
await p.$disconnect();

if (!me) { console.log("no such account"); process.exit(1); }

const token = jwt.sign({ userId: me.id, email: me.email }, process.env.JWT_SECRET, { expiresIn: "5m" });

const res = await fetch(`${API}/api/admin/overview`, {
  headers: { Authorization: `Bearer ${token}` },
});

console.log("GET /api/admin/overview ->", res.status);
if (res.status !== 200) {
  console.log("body:", (await res.text()).slice(0, 300));
  console.log("\nThe running process does not have this address. It read .env at boot.");
  process.exit(1);
}

const data = await res.json();
console.log("\nadmin page is live for", me.email);
const probs = data.problems ?? [];
console.log(`problems reported: ${probs.length}`);
for (const pr of probs) console.log(`  [${pr.level}] ${pr.what}`);
