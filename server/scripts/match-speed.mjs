#!/usr/bin/env node
/**
 * How long two people actually wait to be matched, and to be rematched.
 *
 * The complaint this exists for is not a crash: matching worked, it was just
 * slow enough that people gave up. That is only visible as a number, and only
 * against a running server — the unit tests can prove the rules are right and
 * still say nothing about how it feels.
 *
 * Measures the two cases that matter, both with a tiny room, because that is
 * what a new app has:
 *
 *   1. two strangers arriving       — should be immediate
 *   2. one of them skipping         — the wait before they can meet again
 *
 *   node scripts/match-speed.mjs [baseUrl]
 */
import { io } from "socket.io-client";

const BASE = process.argv[2] || "http://localhost:3001";
const stamp = Date.now();
let seq = 0;

async function register() {
  const name = `spd${stamp.toString(36)}${seq++}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${name}@probe.local`,
      password: "speedtest1234",
      username: name,
      gender: "male",
      country: "IN",
    }),
  });
  if (!res.ok) throw new Error(`register: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
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

const join = (s) => s.emit("join-queue", { gender: "any", countries: [], city: null });

async function idle() {
  for (let i = 0; i < 40; i++) {
    const s = await fetch(`${BASE}/api/stats`).then((r) => r.json());
    if (s.online === 0 && s.queued === 0 && s.activeChats === 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  console.log(`\nMatch speed against ${BASE}\n`);

  if (!(await idle())) {
    console.log("  SKIP  the server is in use; re-run when idle\n");
    process.exit(0);
  }

  const [a, b] = await Promise.all([register(), register()]);
  const [sa, sb] = await Promise.all([connect(a.token), connect(b.token)]);

  // --- first meeting ------------------------------------------------------
  const firstStart = Date.now();
  const firstA = once(sa, "match-found", 90_000);
  join(sa);
  await new Promise((r) => setTimeout(r, 150));
  join(sb);

  const first = await firstA;
  const firstMs = Date.now() - firstStart;
  if (!first) {
    console.log("  FAIL  two strangers were never matched\n");
    process.exit(1);
  }
  console.log(`  strangers matched in            ${firstMs} ms`);

  // --- and again, after a skip -------------------------------------------
  const skipStart = Date.now();
  const againA = once(sa, "match-found", 120_000);
  sa.emit("skip", { roomId: first.roomId });

  // Both have to ask again; skipping does not re-queue the other side.
  await new Promise((r) => setTimeout(r, 300));
  join(sa);
  join(sb);

  const again = await againA;
  const againMs = Date.now() - skipStart;

  if (!again) {
    console.log(`  rematched after a skip in       never (gave up at 120s)`);
  } else {
    console.log(`  rematched after a skip in       ${againMs} ms`);
  }

  // --- and with somebody else in the room --------------------------------
  //
  // The claim worth checking: the floor only bites when there is nobody else.
  // A third person means the skipper has someone new, so it should be instant.
  const c = await register();
  const sc = await connect(c.token);

  // Clear whatever the pair above left running.
  if (again) sa.emit("skip", { roomId: again.roomId });
  await new Promise((r) => setTimeout(r, 500));

  const thirdStart = Date.now();
  const thirdA = once(sa, "match-found", 60_000);
  join(sa);
  await new Promise((r) => setTimeout(r, 150));
  join(sc);

  const third = await thirdA;
  const thirdMs = Date.now() - thirdStart;
  console.log(
    `  matched a fresh face in         ${third ? thirdMs + " ms" : "never"}`,
  );

  console.log("");
  console.log("  The 20s floor is deliberate: it only applies to the person");
  console.log("  just skipped, and only when there is nobody else to meet.");
  console.log("");

  sa.close();
  sb.close();
  sc.close();

  const bad =
    firstMs > 3_000 || !again || againMs > 40_000 || !third || thirdMs > 3_000;
  console.log(bad ? "  Slower than it should be.\n" : "  Both within expectations.\n");
  process.exit(bad ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}\n`);
  process.exit(1);
});
