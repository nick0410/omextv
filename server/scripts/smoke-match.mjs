#!/usr/bin/env node
/**
 * Drive two real clients through a whole conversation against a running
 * server: register, connect, queue, match, chat, skip.
 *
 * The integration suite covers this against a server it starts itself. This
 * runs against whatever is actually deployed, which is what catches the things
 * a test harness cannot — a bad CORS origin, a dead tunnel, migrations that
 * were never applied, a model that failed to load.
 *
 *   node scripts/smoke-match.mjs [baseUrl]
 */
import { io } from "socket.io-client";

const BASE = process.argv[2] || "http://localhost:3001";
const stamp = Date.now();

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

async function register(suffix, gender) {
  const username = `sm${stamp}${suffix}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${username}@smoke.local`,
      password: "smoketest1234",
      username,
      gender,
      country: "IN",
    }),
  });
  if (!res.ok) throw new Error(`register ${suffix}: HTTP ${res.status}`);
  const body = await res.json();
  return { username, token: body.token, id: body.user.id };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ["websocket"], reconnection: false });
    const timer = setTimeout(() => reject(new Error("socket connect timed out")), 15000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const once = (socket, event, ms = 15000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

async function main() {
  console.log(`\nTarget: ${BASE}\n`);

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check("health", health.status === "ok", `store=${health.store}`);

  const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
  check("gender model loaded", stats.genderReady === true, `provider=${stats.genderProvider}`);

  console.log("\n  --- two clients ---");
  const alice = await register("a", "female");
  const bob = await register("b", "male");
  check("registration", Boolean(alice.token && bob.token));

  const sa = await connect(alice.token);
  const sb = await connect(bob.token);
  check("both sockets connected", sa.connected && sb.connected);

  // Alice waits; Bob arrives and should be paired with her.
  sa.emit("join-queue", { gender: "any", countries: [], city: null });
  await once(sa, "queue-joined");

  const matchA = once(sa, "match-found");
  const matchB = once(sb, "match-found");
  sb.emit("join-queue", { gender: "any", countries: [], city: null });

  const [ra, rb] = await Promise.all([matchA, matchB]);
  check("matched with each other", ra.roomId === rb.roomId, `room=${ra.roomId.slice(0, 8)}`);
  check("exactly one initiator", ra.isInitiator !== rb.isInitiator);
  check("partner identity correct", ra.partner.userId === bob.id && rb.partner.userId === alice.id);
  check("no email leaked", !JSON.stringify(ra).includes("@smoke.local"));

  // Signalling relay.
  const offerAtB = once(sb, "offer");
  sa.emit("offer", { roomId: ra.roomId, offer: { type: "offer", sdp: "smoke" } });
  const offer = await offerAtB;
  check("webrtc signalling relayed", offer?.offer?.sdp === "smoke");

  // Text chat.
  const msgAtB = once(sb, "chat-message");
  sa.emit("chat-message", { roomId: ra.roomId, text: "hello from the smoke test" });
  const message = await msgAtB;
  check("chat delivered", message.text === "hello from the smoke test");

  // Skip tears the pair down on both sides.
  const leftAtB = once(sb, "partner-left");
  sa.emit("skip", { roomId: ra.roomId });
  const left = await leftAtB;
  check("skip notifies the partner", left.reason === "skip");

  // ...and they are not immediately re-paired with each other.
  sa.emit("join-queue", { gender: "any", countries: [], city: null });
  await once(sa, "queue-joined");
  sb.emit("join-queue", { gender: "any", countries: [], city: null });
  await once(sb, "queue-joined");

  // No match arriving is the pass condition here, so the timeout rejection is
  // the expected outcome rather than an error.
  const rematched = await once(sa, "match-found", 4000)
    .then(() => true)
    .catch(() => false);
  check("no instant rematch after skip", rematched === false);

  sa.close();
  sb.close();

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nsmoke test error: ${err.message}\n`);
  process.exit(1);
});
