#!/usr/bin/env node
/**
 * Drive the whole Razorpay path against a running server.
 *
 * Everything except the one step a human has to do: typing a card into
 * Razorpay's window. This covers what happens on either side of that — the
 * order reaching Razorpay with our id attached, the handshake being verified,
 * the webhook crediting, and every way both of those must refuse.
 *
 * Reads the keys from server/.env rather than taking them as arguments, so a
 * secret never lands in a shell history.
 *
 *   node scripts/razorpay-check.mjs [baseUrl]
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BASE = process.argv[2] || "http://localhost:3001";
const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let total = 0;
const check = (label, ok, detail = "") => {
  total++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Read one value out of .env without pulling in a parser. */
function fromEnvFile(key) {
  const file = path.join(here, "..", ".env");
  if (!fs.existsSync(file)) return "";
  const line = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "");
}

const post = (p, body, token, headers = {}) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });

const get = (p, token) =>
  fetch(`${BASE}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function register() {
  // Usernames cap at 20 characters, and a full timestamp already spends 13.
  const name = `rzp${Date.now().toString(36)}${Math.floor(Math.random() * 999)}`;
  const res = await post("/api/auth/register", {
    email: `${name}@probe.local`,
    password: "rzpcheck1234",
    username: name,
    gender: "male",
    country: "IN",
  });
  if (!res.ok) throw new Error(`register: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { ...body.user, token: body.token };
}

const sign = (payload, secret) =>
  crypto.createHmac("sha256", secret).update(payload).digest("hex");

async function main() {
  console.log(`\nRazorpay path against ${BASE}\n`);

  const keySecret = fromEnvFile("RAZORPAY_KEY_SECRET");
  const webhookSecret = fromEnvFile("RAZORPAY_WEBHOOK_SECRET");

  const buyer = await register();
  const me = await get("/api/coins/me", buyer.token).then((r) => r.json());

  if (!me.purchasesEnabled) {
    console.log("\n  SKIP  payments are not configured.\n");
    process.exit(0);
  }

  // --- the order --------------------------------------------------------
  const created = await post("/api/coins/orders", { packId: "starter" }, buyer.token);
  const { order, payment } = await created.json();
  check("order created", created.status === 201, `HTTP ${created.status}`);

  if (payment.kind !== "gateway") {
    console.log(
      `\n  SKIP  the active provider is "${payment.provider}", not a gateway.` +
        "\n        Run scripts/set-razorpay.ps1 with -Activate to switch.\n",
    );
    process.exit(0);
  }

  check("Razorpay issued an order id", payment.gatewayOrderId?.startsWith("order_"),
    payment.gatewayOrderId);
  check("the amount is the pack price", payment.amountPaise === 50_000, `${payment.amountPaise}p`);
  check("the publishable key goes to the browser", payment.keyId?.startsWith("rzp_"), payment.keyId);
  // The one thing that must never travel: everything the browser receives is
  // in this object.
  check(
    "the key secret is nowhere in what the browser gets",
    Boolean(keySecret) && !JSON.stringify(payment).includes(keySecret),
  );

  // --- the browser handshake -------------------------------------------
  if (!keySecret) {
    console.log("\n  SKIP  no key secret in .env; cannot forge a valid handshake.\n");
  } else {
    const paymentId = `pay_check${Date.now()}`;
    const good = sign(`${payment.gatewayOrderId}|${paymentId}`, keySecret);

    const forged = await post(
      `/api/coins/orders/${order.id}/verify`,
      {
        razorpay_order_id: payment.gatewayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: sign(`${payment.gatewayOrderId}|${paymentId}`, "wrong_secret"),
      },
      buyer.token,
    );
    check("a forged signature is refused", forged.status === 400, `HTTP ${forged.status}`);

    const stillZero = await get("/api/coins/me", buyer.token).then((r) => r.json());
    check("and credits nothing", stillZero.coins === 0, `${stillZero.coins} coins`);

    const verified = await post(
      `/api/coins/orders/${order.id}/verify`,
      {
        razorpay_order_id: payment.gatewayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: good,
      },
      buyer.token,
    );
    check("a real signature credits the coins", verified.status === 200, `HTTP ${verified.status}`);

    const funded = await get("/api/coins/me", buyer.token).then((r) => r.json());
    check("the coins arrived", funded.coins === 500, `${funded.coins} coins`);

    const again = await post(
      `/api/coins/orders/${order.id}/verify`,
      {
        razorpay_order_id: payment.gatewayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: good,
      },
      buyer.token,
    );
    const twice = await get("/api/coins/me", buyer.token).then((r) => r.json());
    check("replaying it pays nothing more", again.status === 200 && twice.coins === 500,
      `${twice.coins} coins`);
  }

  // --- the webhook ------------------------------------------------------
  if (!webhookSecret) {
    console.log(
      "\n  SKIP  no RAZORPAY_WEBHOOK_SECRET. Without it a buyer who closes the tab" +
        "\n        is charged and never credited.\n",
    );
  } else {
    const second = await post("/api/coins/orders", { packId: "starter" }, buyer.token);
    const fresh = await second.json();

    const body = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: `pay_hook${Date.now()}`, notes: { omextvOrderId: fresh.order.id } },
        },
      },
    });

    const bad = await post("/api/coins/webhook/razorpay", body, null, {
      "x-razorpay-signature": sign(body, "wrong_secret"),
    });
    check("an unsigned webhook is refused", bad.status === 400, `HTTP ${bad.status}`);

    const good = await post("/api/coins/webhook/razorpay", body, null, {
      "x-razorpay-signature": sign(body, webhookSecret),
    });
    check("a signed webhook credits", good.status === 200, `HTTP ${good.status}`);

    const after = await get("/api/coins/me", buyer.token).then((r) => r.json());
    check("coins credited without the browser", after.coins >= 500, `${after.coins} coins`);

    const retry = await post("/api/coins/webhook/razorpay", body, null, {
      "x-razorpay-signature": sign(body, webhookSecret),
    });
    const settled = await get("/api/coins/me", buyer.token).then((r) => r.json());
    check(
      "a retried webhook pays nothing more",
      retry.status === 200 && settled.coins === after.coins,
      `${settled.coins} coins`,
    );
  }

  console.log(
    `\n${failures === 0 ? `All ${total} checks passed.` : `${failures} of ${total} FAILED.`}`,
  );
  console.log("\nWhat this cannot do: type a card into Razorpay's window.");
  console.log("Open /coins, pick a pack, press Pay, and use 4100 2800 0000 1007.\n");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}\n`);
  process.exit(1);
});
