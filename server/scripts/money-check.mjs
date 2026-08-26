#!/usr/bin/env node
/**
 * Can an order be credited more than once, or from a state nobody meant?
 *
 * The state machine says approved is terminal and that is the whole point of
 * it, but a table of legal transitions only helps if every path to crediting
 * actually consults it -- and if two requests arriving together cannot both
 * pass the check before either writes.
 *
 * Money is the one place where the failure is silent: not a crash, just a
 * balance that is wrong and a ledger that says so twice.
 *
 * Needs an administrator. It makes its own, listed in ADMIN_EMAILS for the
 * length of the run only if you pass one; otherwise the approval half is
 * skipped rather than pretending to have checked it.
 *
 *   node -r dotenv/config scripts/money-check.mjs dotenv_config_path=.env
 */
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const BASE = process.env.BASE || "http://localhost:3001";
const prisma = new PrismaClient();

let findings = 0;
let checked = 0;
const ok = (label, condition, detail = "") => {
  checked++;
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!condition) findings++;
};

const stamp = Date.now().toString(36);
let seq = 0;
const made = [];

async function register() {
  const name = `mon${stamp}${seq++}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${name}@probe.test`,
      password: "moneycheck1234",
      username: name,
      gender: "male",
      country: "IN",
    }),
  });
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
  const body = await res.json();
  made.push(body.user.id);
  return { ...body.user, token: body.token };
}

const api = (path, token, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });

const balanceOf = async (id) =>
  (await prisma.user.findUnique({ where: { id }, select: { coins: true } }))?.coins ?? 0;

const ledgerFor = async (id) =>
  prisma.coinLedger.findMany({ where: { userId: id }, select: { delta: true, reason: true } });

async function main() {
  console.log(`\nMoney paths against ${BASE}\n`);

  // An administrator, only if one is already configured. Granting one would be
  // a privilege change, and this script is not the place for that.
  const adminEmail = (process.env.ADMIN_EMAILS ?? "").split(",")[0].trim().toLowerCase();
  const adminRow = adminEmail
    ? await prisma.user.findFirst({ where: { email: adminEmail }, select: { id: true, email: true } })
    : null;
  const adminToken = adminRow
    ? jwt.sign({ userId: adminRow.id, email: adminRow.email }, process.env.JWT_SECRET, { expiresIn: "10m" })
    : null;

  const buyer = await register();

  // --- an order, then the same reference twice ----------------------------
  const created = await api("/api/coins/orders", buyer.token, {
    method: "POST",
    body: JSON.stringify({ packId: "starter" }),
  });
  const order = await created.json();
  const orderId = order.order ? order.order.id : order.id;
  ok("an order can be created", Boolean(orderId), `status ${created.status}`);
  if (!orderId) return;

  const ref = `UTR${Date.now()}`;
  const first = await api(`/api/coins/orders/${orderId}/reference`, buyer.token, {
    method: "POST", body: JSON.stringify({ paymentRef: ref }),
  });
  ok("a reference can be attached", first.ok, `status ${first.status}`);

  ok("attaching a reference credits nothing on its own", (await balanceOf(buyer.id)) === 0,
    `coins=${await balanceOf(buyer.id)}`);

  if (!adminToken) {
    console.log("\n  SKIP  approval -- no account in ADMIN_EMAILS to approve as\n");
  } else {
    // --- two approvals arriving together ---------------------------------
    const both = await Promise.all([
      api(`/api/coins/admin/orders/${orderId}/approve`, adminToken, { method: "POST" }),
      api(`/api/coins/admin/orders/${orderId}/approve`, adminToken, { method: "POST" }),
    ]);
    const approved = both.filter((r) => r.ok).length;
    const afterRace = await balanceOf(buyer.id);
    ok("two simultaneous approvals credit once", approved === 1, `${approved} succeeded`);
    ok("the balance reflects one credit", afterRace === 500, `coins=${afterRace}`);

    const entries = await ledgerFor(buyer.id);
    const credits = entries.filter((e) => e.delta > 0);
    ok("the ledger holds exactly one credit", credits.length === 1, `${credits.length} entries`);

    // --- approving an approved order --------------------------------------
    const again = await api(`/api/coins/admin/orders/${orderId}/approve`, adminToken, { method: "POST" });
    ok("an approved order cannot be approved again", !again.ok, `status ${again.status}`);
    ok("and the balance did not move", (await balanceOf(buyer.id)) === afterRace);

    // --- rejecting an approved order --------------------------------------
    const rejectPaid = await api(`/api/coins/admin/orders/${orderId}/reject`, adminToken, {
      method: "POST", body: JSON.stringify({ note: "changed my mind" }),
    });
    ok("an approved order cannot then be rejected", !rejectPaid.ok, `status ${rejectPaid.status}`);
    ok("the credit survived the attempt", (await balanceOf(buyer.id)) === afterRace,
      `coins=${await balanceOf(buyer.id)}`);

    // --- a rejected order can be corrected, but not credited twice --------
    const second = await api("/api/coins/orders", buyer.token, {
      method: "POST", body: JSON.stringify({ packId: "starter" }),
    });
    const secondBody = await second.json();
    const secondId = secondBody.order ? secondBody.order.id : secondBody.id;
    if (secondId) {
      await api(`/api/coins/orders/${secondId}/reference`, buyer.token, {
        method: "POST", body: JSON.stringify({ paymentRef: `UTR${Date.now()}b` }),
      });
      await api(`/api/coins/admin/orders/${secondId}/reject`, adminToken, {
        method: "POST", body: JSON.stringify({ note: "wrong reference" }),
      });
      const beforeFix = await balanceOf(buyer.id);
      const fixed = await api(`/api/coins/orders/${secondId}/reference`, buyer.token, {
        method: "POST", body: JSON.stringify({ paymentRef: `UTR${Date.now()}c` }),
      });
      ok("a rejected order accepts a corrected reference", fixed.ok, `status ${fixed.status}`);
      ok("correcting it credits nothing by itself", (await balanceOf(buyer.id)) === beforeFix);
    }
  }

  // --- a cancelled order is not payable -----------------------------------
  const third = await api("/api/coins/orders", buyer.token, {
    method: "POST", body: JSON.stringify({ packId: "starter" }),
  });
  const thirdBody = await third.json();
  const thirdId = thirdBody.order ? thirdBody.order.id : thirdBody.id;
  if (thirdId) {
    const before2 = await balanceOf(buyer.id);
    const cancelled = await api(`/api/coins/orders/${thirdId}/cancel`, buyer.token, { method: "POST" });
    if (cancelled.ok) {
      const late = await api(`/api/coins/orders/${thirdId}/reference`, buyer.token, {
        method: "POST", body: JSON.stringify({ paymentRef: "TOOLATE123" }),
      });
      /*
       * "Accepts, or refuses cleanly" was a check that could not fail, which
       * is no check at all. What is actually intended here: cancelling puts
       * the order in rejected, and rejected deliberately accepts a reference
       * so somebody who cancelled and then really did pay can still say so.
       * Approval stays manual, so the worst case is a human looking at it.
       */
      ok("a cancelled order can still be claimed by someone who did pay",
        late.status === 200, `status ${late.status}`);
      ok("and claiming it credited nothing", (await balanceOf(buyer.id)) === before2,
        `coins=${await balanceOf(buyer.id)}`);
    }
  }

  // --- spending more than the balance --------------------------------------
  const before = await balanceOf(buyer.id);
  const spendAll = await Promise.all(
    Array.from({ length: 5 }, () =>
      api("/api/coins/passes", buyer.token, { method: "POST", body: JSON.stringify({ passId: "week" }) })),
  );
  const bought = spendAll.filter((r) => r.ok).length;
  const left = await balanceOf(buyer.id);
  ok("five simultaneous purchases cannot overspend", left >= 0, `coins=${left}`);
  ok("what was spent matches what was bought", left === before - bought * 150,
    `before=${before} bought=${bought} left=${left}`);

  console.log(
    `\n${findings === 0 ? `All ${checked} checks passed.` : `${findings} of ${checked} FAILED.`}\n`,
  );
}

main()
  .catch((err) => { console.error(`\nerror: ${err.message}\n`); process.exitCode = 1; })
  .finally(async () => {
    if (made.length) {
      await prisma.coinLedger.deleteMany({ where: { userId: { in: made } } });
      await prisma.coinOrder.deleteMany({ where: { userId: { in: made } } });
      await prisma.user.deleteMany({ where: { id: { in: made } } });
    }
    await prisma.$disconnect();
    process.exit(findings === 0 ? 0 : 1);
  });
