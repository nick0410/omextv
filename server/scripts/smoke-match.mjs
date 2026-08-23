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

async function register(suffix, gender, country = "IN") {
  const username = `sm${stamp}${suffix}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${username}@smoke.local`,
      password: "smoketest1234",
      username,
      gender,
      country,
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

/**
 * Wait for the queue to acknowledge us, either way.
 *
 * `queue-joined` is only emitted when nobody was waiting. Against a server
 * with real users on it, joining can match instantly instead — so demanding
 * `queue-joined` made this script fail on a perfectly healthy server, which is
 * the worst kind of test.
 */
const queued = (socket, ms = 15000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting to join the queue")),
      ms,
    );
    const done = (how) => (payload) => {
      clearTimeout(timer);
      socket.off("queue-joined", onJoin);
      socket.off("match-found", onMatch);
      resolve({ how, payload });
    };
    const onJoin = done("queued");
    const onMatch = done("matched");
    socket.once("queue-joined", onJoin);
    socket.once("match-found", onMatch);
  });

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
  // Deliberately different countries: the partner's location is shown in the
  // UI and filtered on, so it has to survive the trip through the queue.
  const alice = await register("a", "female", "IN");
  const bob = await register("b", "male", "DE");
  check("registration", Boolean(alice.token && bob.token));

  const sa = await connect(alice.token);
  const sb = await connect(bob.token);
  check("both sockets connected", sa.connected && sb.connected);

  // Alice waits; Bob arrives and should be paired with her. If a real user is
  // already queued, Alice matches them instead and this run cannot prove
  // anything — say so rather than reporting a spurious failure.
  sa.emit("join-queue", { gender: "any", countries: [], city: null });
  const first = await queued(sa);
  if (first.how === "matched") {
    console.log(
      "  SKIP  a real user was already waiting and matched first; " +
        "re-run when the queue is empty",
    );
    sa.close();
    sb.close();
    process.exit(0);
  }

  const matchA = once(sa, "match-found");
  const matchB = once(sb, "match-found");
  sb.emit("join-queue", { gender: "any", countries: [], city: null });

  const [ra, rb] = await Promise.all([matchA, matchB]);
  check("matched with each other", ra.roomId === rb.roomId, `room=${ra.roomId.slice(0, 8)}`);
  check("exactly one initiator", ra.isInitiator !== rb.isInitiator);
  check("partner identity correct", ra.partner.userId === bob.id && rb.partner.userId === alice.id);
  check("no email leaked", !JSON.stringify(ra).includes("@smoke.local"));
  check(
    "partner country reaches the client",
    ra.partner.country === "DE" && rb.partner.country === "IN",
    `saw ${ra.partner.country}/${rb.partner.country}`,
  );

  const online = await fetch(`${BASE}/api/meta/countries/online`).then((r) => r.json());
  const seen = new Set((online.countries ?? []).map((c) => c.country));
  check(
    "online countries reports both",
    seen.has("IN") && seen.has("DE"),
    `saw ${[...seen].join(",") || "nothing"}`,
  );

  const list = await fetch(`${BASE}/api/meta/countries`).then((r) => r.json());
  check("country list is complete", (list.countries ?? []).length === 249);

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
  await queued(sa);
  sb.emit("join-queue", { gender: "any", countries: [], city: null });
  await queued(sb);

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
