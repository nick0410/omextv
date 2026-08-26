#!/usr/bin/env node
/**
 * Does the per-call charge take money from the right person, and only them?
 *
 * The rules have unit tests. What those cannot show is the charge actually
 * landing against a running server: the timer firing, the debit going through,
 * and — the part worth being sure about — the other person's balance not
 * moving. Nobody notices a charge that fails; everybody notices one that
 * should not have happened.
 *
 *   node scripts/call-charge-check.mjs [baseUrl]
 */
import { io } from "socket.io-client";
import { PrismaClient } from "@prisma/client";

const BASE = process.argv[2] || "http://localhost:3001";
const CHARGE = 50;
const prisma = new PrismaClient();

let failures = 0;
let total = 0;
const check = (label, ok, detail = "") => {
  total++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

let seq = 0;
const stamp = Date.now().toString(36);

async function register(gender, coins) {
  const name = `cc${stamp}${seq++}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${name}@probe.local`,
      password: "callcharge1234",
      username: name,
      gender,
      country: "IN",
    }),
  });
  if (!res.ok) throw new Error(`register: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();

  if (coins > 0) {
    await prisma.user.update({ where: { id: body.user.id }, data: { coins } });
  }
  return { ...body.user, token: body.token };
}

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ["websocket"], reconnection: false });
    const t = setTimeout(() => reject(new Error("connect timeout")), 15000);
    s.on("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.on("connect_error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

const once = (s, ev, ms) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(ev, (p) => {
      clearTimeout(t);
      resolve(p ?? true);
    });
  });

const balance = async (id) =>
  (await prisma.user.findUnique({ where: { id }, select: { coins: true } }))?.coins ?? 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function idle() {
  for (let i = 0; i < 40; i++) {
    const s = await fetch(`${BASE}/api/stats`).then((r) => r.json());
    if (s.online === 0 && s.queued === 0 && s.activeChats === 0) return true;
    await wait(500);
  }
  return false;
}

async function main() {
  console.log(`\nPer-call charging against ${BASE}\n`);

  if (!(await idle())) {
    console.log("  SKIP  the server is in use; re-run when idle\n");
    process.exit(0);
  }

  // --- a chooser and someone who chose nothing ---------------------------
  const chooser = await register("male", 200);
  const partner = await register("female", 200);

  const sc = await connect(chooser.token);
  const sp = await connect(partner.token);

  const matched = once(sp, "match-found", 30_000);
  // The chooser asks for women; the partner takes whoever comes.
  sc.emit("join-queue", { gender: "female", countries: [], city: null });
  await wait(300);
  sp.emit("join-queue", { gender: "any", countries: [], city: null });

  const match = await matched;
  check("they were matched", Boolean(match));
  if (!match) process.exit(1);

  check("nothing charged yet", (await balance(chooser.id)) === 200);

  // What a real client sends once its peer connection comes up. Until this
  // arrives the pair exists but no call does, and nothing is billable.
  sc.emit("call-connected", {});
  sp.emit("call-connected", {});

  // Past the threshold.
  await wait(18_000);

  check(
    "the chooser paid",
    (await balance(chooser.id)) === 200 - CHARGE,
    `${await balance(chooser.id)} coins`,
  );
  check(
    "the other person did not",
    (await balance(partner.id)) === 200,
    `${await balance(partner.id)} coins`,
  );

  const entries = await prisma.coinLedger.findMany({ where: { userId: chooser.id } });
  check("the charge is in the ledger", entries.some((e) => e.reason === "call" && e.delta === -CHARGE));
  check(
    "the other person's ledger is untouched",
    (await prisma.coinLedger.count({ where: { userId: partner.id } })) === 0,
  );

  sc.emit("end-chat", { roomId: match.roomId });
  await wait(500);
  sc.close();
  sp.close();
  await wait(9_000);

  // --- a call that ends before it counts ---------------------------------
  const quick = await register("male", 200);
  const other = await register("female", 0);
  const sq = await connect(quick.token);
  const so = await connect(other.token);

  const quickMatch = once(so, "match-found", 30_000);
  sq.emit("join-queue", { gender: "female", countries: [], city: null });
  await wait(300);
  so.emit("join-queue", { gender: "any", countries: [], city: null });
  const m2 = await quickMatch;

  if (m2) {
    // Connected, then left — otherwise this passes for the wrong reason,
    // being free because nothing ever charged rather than because it was short.
    sq.emit("call-connected", {});
    so.emit("call-connected", {});
    // Leave well before the threshold.
    await wait(3_000);
    sq.emit("end-chat", { roomId: m2.roomId });
    await wait(18_000);
    check(
      "a call that ended early is free",
      (await balance(quick.id)) === 200,
      `${await balance(quick.id)} coins`,
    );
  } else {
    check("a call that ended early is free", false, "never matched");
  }

  sq.close();
  so.close();
  await wait(9_000);

  // --- a call that never connected --------------------------------------
  //
  // The one that was being charged for. Without a relay configured this is a
  // large share of real pairings: the room is made, both people look at a
  // black rectangle, and nobody should pay for it. No call-connected is sent,
  // which is exactly what a client whose peer connection never came up does.
  const stuck = await register("male", 200);
  const nobody = await register("female", 0);
  const ss = await connect(stuck.token);
  const sn = await connect(nobody.token);

  const m3 = once(sn, "match-found", 30_000);
  ss.emit("join-queue", { gender: "female", countries: [], city: null });
  await wait(300);
  sn.emit("join-queue", { gender: "any", countries: [], city: null });
  const match3 = await m3;

  if (match3) {
    await wait(18_000);
    check(
      "a call that never connected is free",
      (await balance(stuck.id)) === 200,
      `${await balance(stuck.id)} coins`,
    );
    check(
      "and nothing reached the ledger",
      (await prisma.coinLedger.count({ where: { userId: stuck.id } })) === 0,
    );
    ss.emit("end-chat", { roomId: match3.roomId });
  } else {
    check("a call that never connected is free", false, "never matched");
  }

  await wait(500);
  ss.close();
  sn.close();

  console.log(
    `\n${failures === 0 ? `All ${total} checks passed.` : `${failures} of ${total} FAILED.`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error(`\nerror: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
