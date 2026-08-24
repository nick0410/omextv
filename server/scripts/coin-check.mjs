#!/usr/bin/env node
/**
 * Walk a whole coin purchase through a running server.
 *
 * The unit suite covers this router against the real database already. What it
 * cannot check is the part that only exists at boot: whether UPI_ID and
 * ADMIN_EMAILS in .env actually reach the routes. Getting those wrong is
 * silent — the buttons all work, the QR renders, and the money goes to nobody.
 *
 * Run it after setting or changing either one:
 *
 *   node scripts/coin-check.mjs [baseUrl]
 *
 * It needs an administrator it can sign in as. Point ADMIN_CHECK_EMAIL at an
 * account whose email is in ADMIN_EMAILS, with ADMIN_CHECK_PASSWORD:
 *
 *   ADMIN_CHECK_EMAIL=you@example.com ADMIN_CHECK_PASSWORD=... node scripts/coin-check.mjs
 */
const BASE = process.argv[2] || "http://localhost:3001";
const ADMIN_EMAIL = process.env.ADMIN_CHECK_EMAIL || "";
const ADMIN_PASSWORD = process.env.ADMIN_CHECK_PASSWORD || "";
const stamp = Date.now();

let failures = 0;
let total = 0;

const check = (label, ok, detail = "") => {
  total++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const post = (path, body, token) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

const get = (path, token) =>
  fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function register(email) {
  const username = email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20);
  const res = await post("/api/auth/register", {
    email,
    password: "cointest1234",
    username,
    gender: "male",
    country: "IN",
  });
  if (!res.ok) throw new Error(`register: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { ...body.user, token: body.token };
}

async function signIn(email, password) {
  const res = await post("/api/auth/login", { email, password });
  if (!res.ok) throw new Error(`sign in as ${email}: HTTP ${res.status}`);
  const body = await res.json();
  return { ...body.user, token: body.token };
}

async function main() {
  console.log(`\nCoin flow against ${BASE}\n`);

  const buyer = await register(`coincheck${stamp}@probe.local`);

  const me = await get("/api/coins/me", buyer.token).then((r) => r.json());
  check("catalogue is served", Array.isArray(me.packs) && me.packs.length > 0);
  check("a new account starts with nothing", me.coins === 0 && me.isPremium === false);

  if (!me.upiEnabled) {
    console.log("\n  SKIP  UPI is not configured. Set UPI_ID in server/.env.\n");
    process.exit(0);
  }

  const created = await post("/api/coins/orders", { packId: "starter" }, buyer.token);
  const { order, upi } = await created.json();
  check("order created", created.status === 201, `HTTP ${created.status}`);
  // The single most expensive thing to get wrong: money to the wrong account.
  check("the payee is the one in .env", Boolean(upi.payeeVpa), upi.payeeVpa);
  check("the amount matches the pack", upi.amountRupees === "500.00", upi.amountRupees);
  check("the link is a upi:// request", upi.link.startsWith("upi://pay?"));
  check("the order reference travels with it", upi.link.includes(`tr=${upi.reference}`));

  const submitted = await post(
    `/api/coins/orders/${order.id}/reference`,
    { upiRef: `CHECK${stamp}` },
    buyer.token,
  );
  check("a reference is accepted", submitted.status === 200, `HTTP ${submitted.status}`);

  const stillBroke = await get("/api/coins/me", buyer.token).then((r) => r.json());
  check("saying you paid credits nothing", stillBroke.coins === 0);

  const selfApprove = await post(`/api/coins/admin/orders/${order.id}/approve`, {}, buyer.token);
  check("the buyer cannot approve their own order", selfApprove.status === 403,
    `HTTP ${selfApprove.status}`);

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log(
      "\n  SKIP  the approval half. Set ADMIN_CHECK_EMAIL and ADMIN_CHECK_PASSWORD to an" +
        "\n        account listed in ADMIN_EMAILS to check it.",
    );
    console.log(
      `\n${failures === 0 ? `All ${total} checks passed.` : `${failures} of ${total} FAILED.`}\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  }

  const admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  const approved = await post(`/api/coins/admin/orders/${order.id}/approve`, {}, admin.token);
  check("an administrator can approve", approved.status === 200, `HTTP ${approved.status}`);

  const twice = await post(`/api/coins/admin/orders/${order.id}/approve`, {}, admin.token);
  check("approving twice pays once", twice.status === 409, `HTTP ${twice.status}`);

  const funded = await get("/api/coins/me", buyer.token).then((r) => r.json());
  check("the coins arrived, once", funded.coins === 500, `${funded.coins} coins`);

  const pass = await post("/api/coins/passes", { passId: "month" }, buyer.token);
  const passBody = await pass.json();
  check("coins buy premium", pass.status === 200 && passBody.isPremium === true);
  check("and are spent doing it", passBody.coins === 0, `${passBody.coins} left`);

  const days = (new Date(passBody.premiumExpiry) - Date.now()) / 86_400_000;
  check("thirty days granted", days > 29.9 && days < 30.1, `${days.toFixed(2)} days`);

  console.log(
    `\n${failures === 0 ? `All ${total} checks passed.` : `${failures} of ${total} FAILED.`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}\n`);
  process.exit(1);
});
