#!/usr/bin/env node
/**
 * Second round of probes: the stateful rules.
 *
 * These are the ones that cannot be checked by poking a single endpoint —
 * whether a block really stops a match, whether a ban really stops a
 * connection, what happens when the same account opens two tabs, and whether
 * a burst of simultaneous joins pairs everyone exactly once.
 *
 *   node scripts/probe2.mjs [baseUrl]
 */
import { io } from "socket.io-client";

const BASE = process.argv[2] || "http://localhost:3001";
const stamp = Date.now();
let failures = 0;
let total = 0;

const check = (label, ok, detail = "") => {
  total++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

let seq = 0;
async function register(over = {}) {
  const username = `q${stamp}${seq++}`;
  const res = await post("/api/auth/register", {
    email: `${username}@probe.local`,
    password: "probetest1234",
    username,
    gender: "male",
    country: "IN",
    ...over,
  });
  if (!res.ok) throw new Error(`register: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { ...body.user, token: body.token, username };
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

const once = (s, ev, ms = 8000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(ev, (p) => {
      clearTimeout(t);
      resolve(p ?? true);
    });
  });

const join = (s) => s.emit("join-queue", { gender: "any", countries: [], city: null });

async function stats() {
  return fetch(`${BASE}/api/stats`).then((r) => r.json());
}

/**
 * Wait for the server to be genuinely idle again.
 *
 * A disconnected user's chat is deliberately held open for RECONNECT_GRACE_MS
 * so a dropped connection does not instantly cost them their partner. Asserting
 * on teardown before that expires reports a leak that is not there.
 */
async function settle(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await stats();
    if (s.queued === 0 && s.activeChats === 0 && s.online === 0) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  console.log(`\nProbing ${BASE}\n`);

  const start = await stats();
  if (start.online !== 0 || start.queued !== 0 || start.activeChats !== 0) {
    console.log("  SKIP  the server is in use; re-run when idle\n");
    process.exit(0);
  }

  // ---------- blocking ----------
  console.log("  --- blocking ---");
  const a = await register();
  const b = await register({ gender: "female", country: "DE" });

  const blocked = await post(
    "/api/report/block",
    { blockedId: b.id },
    { authorization: `Bearer ${a.token}` },
  );
  check("a block is accepted", blocked.ok, `HTTP ${blocked.status}`);

  const sa = await connect(a.token);
  const sb = await connect(b.token);

  const matchA = once(sa, "match-found", 6000);
  join(sa);
  await new Promise((r) => setTimeout(r, 400));
  join(sb);
  const gotMatch = await matchA;
  check("a blocked pair is never matched", gotMatch === null);

  // The block is one-directional in the data but must apply both ways.
  const blockedStats = await stats();
  check(
    "both stay in the queue rather than being dropped",
    blockedStats.queued === 2,
    `queued=${blockedStats.queued}`,
  );

  sa.emit("leave-queue");
  sb.emit("leave-queue");
  await new Promise((r) => setTimeout(r, 300));

  const unblocked = await fetch(`${BASE}/api/report/block/${b.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${a.token}` },
  });
  check("a block can be lifted", unblocked.ok, `HTTP ${unblocked.status}`);

  const matchAfter = once(sa, "match-found", 8000);
  join(sa);
  await new Promise((r) => setTimeout(r, 400));
  join(sb);
  const afterMatch = await matchAfter;
  check("they match once the block is gone", afterMatch !== null);

  // end-chat needs the room; without it the pair survives and the next
  // section starts with someone already talking.
  if (afterMatch) sa.emit("end-chat", { roomId: afterMatch.roomId });
  sa.close();
  sb.close();
  await settle();

  // ---------- one account, two tabs ----------
  console.log("\n  --- one account, two tabs ---");
  const c = await register();
  const first = await connect(c.token);
  const evicted = once(first, "disconnect", 6000);
  const second = await connect(c.token);
  const wasEvicted = await evicted;

  check(
    "opening a second tab does not leave two live sessions",
    wasEvicted !== null || !first.connected,
    wasEvicted ? "first socket was closed" : "first socket still open",
  );
  check("the newest tab is the one that works", second.connected);

  const onlineStats = await stats();
  check("the user is counted once, not twice", onlineStats.online <= 1, `online=${onlineStats.online}`);
  first.close();
  second.close();
  await settle();

  // ---------- a burst of joins ----------
  console.log("\n  --- a burst of joins ---");
  const crowd = await Promise.all(Array.from({ length: 6 }, () => register()));
  const sockets = await Promise.all(crowd.map((u) => connect(u.token)));

  const rooms = new Map();
  const seen = [];
  sockets.forEach((s, i) => {
    s.on("match-found", (m) => {
      seen.push({ i, roomId: m.roomId, partner: m.partner.userId });
      rooms.set(m.roomId, (rooms.get(m.roomId) ?? 0) + 1);
    });
  });

  // All at once, which is where a matchmaker without a lock double-pairs.
  sockets.forEach(join);

  // Wait for the outcome, not for a fixed number of seconds.
  //
  // Pairing a burst is not uniform: the first pair can land inside 200ms while
  // the last waits on the next sweep, so measured runs finish anywhere between
  // 300ms and two seconds. A sleep long enough to be safe today is a sleep
  // that reports a phantom failure the day the machine is busier — and it
  // reports it as "the matchmaker lost someone", which is a real bug's
  // signature and costs an hour to disbelieve.
  const deadline = Date.now() + 15000;
  while (seen.length < 6 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const missing = crowd
    .map((u, i) => (seen.some((s) => s.i === i) ? null : u.username))
    .filter(Boolean);
  check(
    "everyone got exactly one match",
    seen.length === 6,
    seen.length === 6 ? "" : `${seen.length} matches; no match for ${missing.join(", ")}`,
  );
  check(
    "every room holds exactly two people",
    [...rooms.values()].every((n) => n === 2),
    `rooms: ${[...rooms.values()].join(",")}`,
  );
  check("nobody was paired with themselves", seen.every((s) => s.partner !== crowd[s.i].id));

  // Same reason: the counters catch up a moment after the last match-found is
  // delivered, so read them until they agree or the wait runs out.
  let after = await stats();
  const countsDeadline = Date.now() + 5000;
  while ((after.queued !== 0 || after.activeChats !== 3) && Date.now() < countsDeadline) {
    await new Promise((r) => setTimeout(r, 200));
    after = await stats();
  }
  check("the queue drained", after.queued === 0, `queued=${after.queued}`);
  check("three chats are live", after.activeChats === 3, `chats=${after.activeChats}`);

  sockets.forEach((s) => s.close());
  const drained = await settle();
  check(
    "disconnecting tears the chats down, once the grace period is up",
    drained.activeChats === 0 && drained.online === 0,
    `chats=${drained.activeChats} online=${drained.online}`,
  );

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check("server survived every probe", health.status === "ok");

  console.log(
    `\n${failures === 0 ? `All ${total} probes passed.` : `${failures} of ${total} FAILED.`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nprobe error: ${err.message}\n`);
  process.exit(1);
});
