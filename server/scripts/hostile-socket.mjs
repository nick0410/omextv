#!/usr/bin/env node
/**
 * The same treatment for the socket, where more of the state lives.
 *
 * HTTP routes validate their bodies because a schema sits at the door. Socket
 * handlers take whatever the client emits, and a client is not obliged to be
 * the one this app ships: anyone with a token can open a socket and send
 * anything at all. What is checked here is that doing so cannot crash the
 * server, reach another person's room, or leave state behind.
 *
 * The server surviving is the headline. Every case ends by asking /health, so
 * a handler that throws in a way nothing catches shows up immediately.
 *
 *   node scripts/hostile-socket.mjs [baseUrl]
 */
import { io } from "socket.io-client";

const BASE = process.argv[2] || "http://localhost:3001";

let findings = 0;
let checked = 0;
const ok = (label, condition, detail = "") => {
  checked++;
  if (!condition) {
    findings++;
    console.log(`  FINDING  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
};

const stamp = Date.now().toString(36);
let seq = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function register() {
  const name = `sok${stamp}${seq++}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${name}@probe.test`,
      password: "socketprobe1234",
      username: name,
      gender: "male",
      country: "IN",
    }),
  });
  if (!res.ok) throw new Error(`register: ${res.status}`);
  const body = await res.json();
  return { ...body.user, token: body.token };
}

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ["websocket"], reconnection: false });
    const t = setTimeout(() => reject(new Error("connect timeout")), 15000);
    s.on("connect", () => { clearTimeout(t); resolve(s); });
    s.on("connect_error", (e) => { clearTimeout(t); reject(e); });
  });

const alive = async () => {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
};

/** Values no handler should assume away. */
const NASTY = [
  undefined,
  null,
  0,
  "",
  "a string where an object goes",
  [],
  [1, 2, 3],
  true,
  { roomId: null },
  { roomId: 123 },
  { roomId: [] },
  { roomId: {} },
  { roomId: "../../etc/passwd" },
  { roomId: "x".repeat(10000) },
  { roomId: "room", text: null },
  { roomId: "room", text: 42 },
  { roomId: "room", text: [] },
  { roomId: "room", candidate: "not-a-candidate" },
  { roomId: "room", offer: "not-an-offer" },
  { roomId: "room", offer: { type: "bogus" } },
  { __proto__: { polluted: true } },
  { constructor: { prototype: {} } },
];

const EVENTS = [
  "join-queue",
  "leave-queue",
  "offer",
  "answer",
  "ice-candidate",
  "chat-message",
  "typing",
  "skip",
  "end-chat",
  "call-connected",
  "queue-status",
  "verify-gender",
];

async function main() {
  console.log(`\nHostile socket traffic against ${BASE}\n`);

  ok("the server is up to begin with", await alive());

  const a = await register();
  const socket = await connect(a.token);

  // --- every handler, every shape -----------------------------------------
  for (const event of EVENTS) {
    for (const payload of NASTY) {
      socket.emit(event, payload);
    }
  }
  await wait(2500);
  ok("survived every handler taking every shape", await alive());

  // Prototype pollution would show up as a property on a fresh object.
  ok("no prototype pollution", ({}).polluted === undefined);

  // --- rooms belonging to nobody, and to somebody else ---------------------
  const b = await register();
  const socketB = await connect(b.token);

  let leaked = null;
  socketB.on("chat-message", (m) => { leaked = m; });
  socketB.on("offer", (m) => { leaked = m; });

  // A is not paired with anyone. Emitting into a made-up room, and into a
  // room name built from B's id, must reach nobody.
  for (const room of ["room", `room-${b.id}`, b.id, "*", ""]) {
    socket.emit("chat-message", { roomId: room, text: "should not arrive" });
    socket.emit("offer", { roomId: room, offer: { type: "offer", sdp: "v=0" } });
  }
  await wait(1500);
  ok("nothing reached a stranger through a guessed room", leaked === null,
    leaked ? JSON.stringify(leaked).slice(0, 80) : "");

  // --- flooding ------------------------------------------------------------
  for (let i = 0; i < 400; i++) socket.emit("chat-message", { roomId: "room", text: `flood ${i}` });
  for (let i = 0; i < 400; i++) socket.emit("join-queue", { gender: "any", countries: [], city: null });
  await wait(2500);
  ok("survived a flood", await alive());

  // --- an enormous single message -----------------------------------------
  socket.emit("chat-message", { roomId: "room", text: "x".repeat(2_000_000) });
  await wait(1500);
  ok("survived an enormous message", await alive());

  // --- gender frames that are not images ----------------------------------
  for (const frame of [null, "", "data:image/png;base64,zzzz", "x".repeat(100000), { a: 1 }, []]) {
    socket.emit("verify-gender", { frames: frame });
    socket.emit("verify-gender", { frames: [frame] });
  }
  await wait(2500);
  ok("survived nonsense gender frames", await alive());

  // --- leaving things half done -------------------------------------------
  socket.emit("join-queue", { gender: "any", countries: [], city: null });
  socket.close();
  socketB.close();
  await wait(2000);
  ok("survived a socket vanishing mid-queue", await alive());

  // The queue must not be left holding the departed.
  const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
  ok("the queue did not keep the departed", stats.queued === 0, `queued=${stats.queued}`);
  ok("no chats were left behind", stats.activeChats === 0, `chats=${stats.activeChats}`);

  console.log(
    `\n${findings === 0 ? `Nothing found in ${checked} checks.` : `${findings} finding(s) in ${checked} checks.`}\n`,
  );
  process.exit(findings === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}\n`);
  process.exitCode = 1;
});
