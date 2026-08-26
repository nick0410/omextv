#!/usr/bin/env node
/**
 * Do the rules that cost money or protect people actually hold?
 *
 * Each of these is a rule the app states somewhere: a banned account is out, a
 * lapsed pass stops being a pass, a balance cannot be spent twice, and a limit
 * limits. Stating them is easy and none of the existing checks make any of
 * them true -- they are only true if the code says no when it should.
 *
 * State is set directly in the database rather than through the API, because
 * the point is to test the gate and not the thing in front of it.
 *
 *   node -r dotenv/config scripts/enforce-check.mjs dotenv_config_path=.env
 */
import { io } from "socket.io-client";
import { PrismaClient } from "@prisma/client";

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function register() {
  const name = `enf${stamp}${seq++}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${name}@probe.test`,
      password: "enforcecheck1234",
      username: name,
      gender: "male",
      country: "IN",
    }),
  });
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { ...body.user, token: body.token, password: "enforcecheck1234" };
}

const api = (path, token, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });

const tryConnect = (token) =>
  new Promise((resolve) => {
    const s = io(BASE, { auth: { token }, transports: ["websocket"], reconnection: false });
    const t = setTimeout(() => { s.close(); resolve({ connected: false, reason: "timeout" }); }, 8000);
    s.on("connect", () => { clearTimeout(t); resolve({ connected: true, socket: s }); });
    s.on("connect_error", (e) => { clearTimeout(t); resolve({ connected: false, reason: e.message }); });
  });

const made = [];

async function main() {
  console.log(`\nRules that cost money or protect people, against ${BASE}\n`);

  // --- a banned account is out --------------------------------------------
  const banned = await register();
  made.push(banned.id);
  await prisma.user.update({ where: { id: banned.id }, data: { isBanned: true } });

  const bannedSocket = await tryConnect(banned.token);
  ok("a banned account cannot open a socket", !bannedSocket.connected, bannedSocket.reason);
  if (bannedSocket.socket) bannedSocket.socket.close();

  const bannedLogin = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: banned.email, password: banned.password }),
  });
  ok("a banned account cannot sign in", bannedLogin.status >= 400, `got ${bannedLogin.status}`);

  // The token it already held must stop working too, or a ban simply waits
  // seven days for the token to expire.
  const heldToken = await api("/api/coins/me", banned.token);
  ok("a token held from before the ban stops working", heldToken.status >= 400,
    `got ${heldToken.status}`);

  // And a ban with a date on it has to end by itself.
  await prisma.user.update({
    where: { id: banned.id },
    data: { isBanned: true, bannedUntil: new Date(Date.now() - 60_000) },
  });
  const served = await api("/api/coins/me", banned.token);
  ok("a ban that has been served lets the account back in", served.status === 200,
    `got ${served.status}`);

  // --- a lapsed pass is not a pass ----------------------------------------
  const lapsed = await register();
  made.push(lapsed.id);
  await prisma.user.update({
    where: { id: lapsed.id },
    data: { isPremium: true, premiumExpiry: new Date(Date.now() - 60_000) },
  });

  const wallet = await api("/api/coins/me", lapsed.token).then((r) => r.json());
  ok("a lapsed pass does not read as premium", wallet.isPremium !== true,
    `isPremium=${wallet.isPremium}`);

  // The gate that matters: choosing a gender with no pass and no coins.
  const lapsedSocket = await tryConnect(lapsed.token);
  ok("the lapsed account can still connect", lapsedSocket.connected);
  if (lapsedSocket.socket) {
    const s = lapsedSocket.socket;
    /*
     * Two separate facts, kept apart on purpose.
     *
     * The first version asked whether the reply mentioned "gender" anywhere,
     * and it did -- inside the echoed filters, as "gender":"any". It would
     * have passed with nothing restricted at all, which is the sort of check
     * that is worse than not having one.
     */
    let restricted = null;
    let joined = null;
    s.on("filters-restricted", (p) => { restricted = p; });
    s.on("queue-joined", (p) => { joined = p; });
    s.emit("join-queue", { gender: "female", countries: [], city: null });
    await wait(1500);

    const saidSo = Boolean(restricted) &&
      Array.isArray(restricted.dropped) &&
      restricted.dropped.includes("gender");
    ok("choosing a gender without a pass or coins is reported as dropped", saidSo,
      restricted ? JSON.stringify(restricted.dropped) : "no filters-restricted event");

    const wasDowngraded = joined && joined.filters && joined.filters.gender === "any";
    ok("and the search really was widened, not just narrated", Boolean(wasDowngraded),
      joined ? `gender=${joined.filters && joined.filters.gender}` : "no queue-joined event");
    s.emit("leave-queue");
    await wait(300);
    s.close();
  }

  // --- a balance cannot be spent twice ------------------------------------
  const spender = await register();
  made.push(spender.id);
  // Enough for exactly one pass, then try to buy two at once.
  const passes = await api("/api/coins/passes", spender.token).then((r) => r.ok ? r.json() : null);
  await prisma.user.update({ where: { id: spender.id }, data: { coins: 30 } });

  const buyTwice = await Promise.all([
    api("/api/coins/passes", spender.token, { method: "POST", body: JSON.stringify({ passId: "day" }) }),
    api("/api/coins/passes", spender.token, { method: "POST", body: JSON.stringify({ passId: "day" }) }),
  ]);
  const succeeded = buyTwice.filter((r) => r.ok).length;
  const after = await prisma.user.findUnique({ where: { id: spender.id }, select: { coins: true } });
  ok("thirty coins bought at most one thirty-coin pass", succeeded <= 1,
    `${succeeded} succeeded, ${after.coins} coins left`);
  ok("the balance did not go negative", after.coins >= 0, `coins=${after.coins}`);
  void passes;

  // --- a limit limits ------------------------------------------------------
  //
  // The limiter skips loopback on purpose, so the local scripts and the health
  // check are never throttled. Running this against localhost therefore proves
  // nothing either way, and reporting "not limited" from here would be the
  // check misreading its own setup. Point BASE at the tunnel to see it work.
  const local = BASE.includes("localhost") || BASE.includes("127.0.0.1");
  if (local) {
    console.log("  SKIP  rate limiting -- the limiter skips loopback; run with BASE=<tunnel url>");
  } else {
    const flooder = await register();
    made.push(flooder.id);
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: flooder.email, password: "wrongpassword" }),
      });
      if (r.status === 429) { sawLimit = true; break; }
    }
    ok("repeated failed sign-ins are rate limited", sawLimit, "no 429 in 40 attempts");
  }

  console.log(
    `\n${findings === 0 ? `All ${checked} checks passed.` : `${findings} of ${checked} FAILED.`}\n`,
  );
}

main()
  .catch((err) => { console.error(`\nerror: ${err.message}\n`); process.exitCode = 1; })
  .finally(async () => {
    if (made.length) await prisma.user.deleteMany({ where: { id: { in: made } } });
    await prisma.$disconnect();
    process.exit(findings === 0 ? 0 : 1);
  });
