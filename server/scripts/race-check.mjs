#!/usr/bin/env node
/**
 * What happens when a lot of people do the same thing at the same instant.
 *
 * Matching is the part of this app where two requests touch the same rows: two
 * people are taken out of a queue and joined, and the whole thing is wrong if
 * either of them was taken twice. With two users at a time that never happens
 * by accident, which is why the existing checks have never caught it.
 *
 * Everything here is about pairs adding up. Nobody in two rooms, nobody in a
 * room alone, nobody paired with themselves, and nobody left in the queue when
 * the music stops.
 *
 *   node scripts/race-check.mjs [baseUrl] [count]
 */
import { io } from "socket.io-client";

const BASE = process.argv[2] || "http://localhost:3001";
const COUNT = Number(process.argv[3] || 16);

let findings = 0;
let checked = 0;
const ok = (label, condition, detail = "") => {
  checked++;
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!condition) findings++;
};

const stamp = Date.now().toString(36);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(i) {
  const name = `race${stamp}${i}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${name}@probe.test`,
      password: "racecheck12345",
      username: name,
      gender: i % 2 === 0 ? "male" : "female",
      country: "IN",
    }),
  });
  if (!res.ok) throw new Error(`register ${i}: ${res.status}`);
  const body = await res.json();
  return { ...body.user, token: body.token };
}

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ["websocket"], reconnection: false });
    const t = setTimeout(() => reject(new Error("connect timeout")), 20000);
    s.on("connect", () => { clearTimeout(t); resolve(s); });
    s.on("connect_error", (e) => { clearTimeout(t); reject(e); });
  });

async function idle() {
  for (let i = 0; i < 60; i++) {
    const s = await fetch(`${BASE}/api/stats`).then((r) => r.json());
    if (s.online === 0 && s.queued === 0 && s.activeChats === 0) return true;
    await wait(500);
  }
  return false;
}

async function main() {
  console.log(`\n${COUNT} people joining at once, against ${BASE}\n`);

  if (!(await idle())) {
    console.log("  SKIP  the server is in use; re-run when idle\n");
    process.exit(0);
  }

  const people = await Promise.all(Array.from({ length: COUNT }, (_, i) => register(i)));
  const sockets = await Promise.all(people.map((p) => connect(p.token)));

  // Who each socket was told it is talking to.
  const matchedWith = new Map(); // userId -> partnerId
  const matchCount = new Map(); // userId -> how many match-found it saw
  const rooms = new Map(); // roomId -> Set(userId)
  const currentRoom = new Map(); // userId -> the room it was last put in
  const refusals = []; // anything the server said no to

  sockets.forEach((s, i) => {
    const me = people[i].id;
    matchCount.set(me, 0);
    s.on("error", (e) => refusals.push(`${me.slice(-6)}: ${JSON.stringify(e).slice(0, 60)}`));
    s.on("queue-error", (e) => refusals.push(`${me.slice(-6)}: ${JSON.stringify(e).slice(0, 60)}`));
    s.on("match-found", (m) => {
      currentRoom.set(me, m.roomId);
      matchCount.set(me, matchCount.get(me) + 1);
      matchedWith.set(me, m.partner && (m.partner.userId || m.partner.id));
      if (!rooms.has(m.roomId)) rooms.set(m.roomId, new Set());
      rooms.get(m.roomId).add(me);
    });
  });

  // The actual race: everyone joins in the same tick.
  sockets.forEach((s) => s.emit("join-queue", { gender: "any", countries: [], city: null }));
  await wait(6000);

  const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());

  // --- nobody matched twice ------------------------------------------------
  const doubled = [...matchCount.entries()].filter(([, n]) => n > 1);
  ok("nobody was matched more than once", doubled.length === 0,
    doubled.map(([id, n]) => `${id.slice(-6)}x${n}`).join(" "));

  // --- every room holds exactly two ---------------------------------------
  const wrongSize = [...rooms.entries()].filter(([, members]) => members.size !== 2);
  ok("every room holds exactly two people", wrongSize.length === 0,
    wrongSize.map(([r, m]) => `${r.slice(-6)}:${m.size}`).join(" "));

  // --- pairings agree with each other -------------------------------------
  const disagreements = [];
  for (const [me, partner] of matchedWith) {
    if (!partner) continue;
    if (me === partner) { disagreements.push(`${me.slice(-6)} paired with itself`); continue; }
    const theirs = matchedWith.get(partner);
    if (theirs !== me) disagreements.push(`${me.slice(-6)} says ${partner.slice(-6)}, who says ${String(theirs).slice(-6)}`);
  }
  ok("both ends of every pair name each other", disagreements.length === 0,
    disagreements.slice(0, 3).join("; "));

  // --- the totals add up ---------------------------------------------------
  const matched = [...matchCount.values()].filter((n) => n > 0).length;
  ok("the number matched is even", matched % 2 === 0, `${matched} of ${COUNT}`);
  ok("active chats match the pairs formed", stats.activeChats === matched / 2,
    `chats=${stats.activeChats} pairs=${matched / 2}`);
  ok("whoever is left over is still queued, not lost",
    stats.queued === COUNT - matched, `queued=${stats.queued} unmatched=${COUNT - matched}`);

  // --- everyone skips at once, repeatedly ---------------------------------
  //
  // Skipping is where the same rows get touched hardest: a pair is torn down
  // and both halves go back into a queue the other half is also entering, so
  // the window for taking somebody twice is at its widest. Three rounds,
  // because a leak here shows as a drift rather than a single wrong answer.
  for (let round = 0; round < 3; round++) {
    matchCount.forEach((_, id) => matchCount.set(id, 0));
    rooms.clear();
    refusals.length = 0;

    /*
     * Skip naming the room actually held.
     *
     * The first version sent roomId: null and then asked to rejoin. The server
     * refused the skip, so the pair stood, and the rejoin was refused too --
     * leaving twelve of sixteen neither matched nor queued. The check passed
     * anyway because it was written as "chats*2 + queued <= COUNT", which is
     * true of any number of people going missing. An upper bound is not an
     * accounting.
     */
    /*
     * What the real client does: tear the pair down, then ask for another.
     *
     * skip only ends the chat; rejoining is a separate emit. The first version
     * of this only skipped, found nobody in a chat or a queue afterwards, and
     * was right to -- they had all left and none had asked for anything. It
     * was measuring its own omission.
     */
    sockets.forEach((s, i) => {
      const room = currentRoom.get(people[i].id);
      if (room) s.emit("skip", { roomId: room });
      currentRoom.delete(people[i].id);
      s.emit("join-queue", { gender: "any", countries: [], city: null });
    });
    await wait(5000);

    const mid = await fetch(`${BASE}/api/stats`).then((r) => r.json());
    const doubledNow = [...matchCount.values()].filter((n) => n > 1).length;
    ok(`round ${round + 1}: nobody matched twice`, doubledNow === 0, `${doubledNow} did`);

    // Everyone is in exactly one of the two places, and the two add up.
    const accounted = mid.activeChats * 2 + mid.queued;
    ok(`round ${round + 1}: everyone is either in a chat or in the queue`,
      accounted === COUNT,
      `chats=${mid.activeChats}x2 + queued=${mid.queued} = ${accounted}, expected ${COUNT}`);
    ok(`round ${round + 1}: the server refused nothing`, refusals.length === 0,
      refusals.slice(0, 2).join("; "));
  }

  // --- everyone leaves at once --------------------------------------------
  sockets.forEach((s) => s.close());
  await wait(4000);

  const after = await fetch(`${BASE}/api/stats`).then((r) => r.json());
  ok("the queue empties when everyone leaves", after.queued === 0, `queued=${after.queued}`);
  ok("presence empties too", after.online === 0, `online=${after.online}`);

  console.log(
    `\n${findings === 0 ? `All ${checked} checks passed.` : `${findings} of ${checked} FAILED.`}\n`,
  );
  process.exit(findings === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}\n`);
  process.exitCode = 1;
});
