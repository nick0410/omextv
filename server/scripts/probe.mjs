#!/usr/bin/env node
/**
 * Adversarial probes against a running server.
 *
 * The unit suite checks the code the way it is meant to be used. This checks
 * what happens when it is not: tampered tokens, oversized payloads, rooms the
 * caller was never in, outsiders trying to tear down someone else's chat.
 * Those paths are not exercised by ordinary use, so they are the ones that rot
 * quietly.
 *
 *   node scripts/probe.mjs [baseUrl]
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

async function register(suffix, over = {}) {
  const username = `pb${stamp}${suffix}`;
  const res = await post("/api/auth/register", {
    email: `${username}@probe.local`,
    password: "probetest1234",
    username,
    gender: "male",
    country: "IN",
    ...over,
  });
  if (!res.ok) throw new Error(`register ${suffix}: HTTP ${res.status} ${await res.text()}`);
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

/** Resolve with the payload, or null if the event never arrives. */
const once = (s, ev, ms = 8000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(ev, (p) => {
      clearTimeout(t);
      resolve(p ?? true);
    });
  });

const queued = (s, ms = 10000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ how: "timeout" }), ms);
    const done = (how) => (p) => {
      clearTimeout(t);
      s.off("queue-joined", onJoin);
      s.off("match-found", onMatch);
      resolve({ how, payload: p });
    };
    const onJoin = done("queued");
    const onMatch = done("matched");
    s.once("queue-joined", onJoin);
    s.once("match-found", onMatch);
  });

async function main() {
  console.log(`\nProbing ${BASE}\n`);

  console.log("  --- auth ---");
  check(
    "rejects a socket with no token",
    await connect(undefined).then(() => false).catch(() => true),
  );
  check(
    "rejects a garbage token",
    await connect("not-a-jwt").then(() => false).catch(() => true),
  );
  // Well-formed JWT, valid claims, signature that was never produced by the
  // server's key. The one that matters: a decoder that skips verification
  // would accept this.
  const forged =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJ1c2VySWQiOiJmYWtlIiwiZW1haWwiOiJhQGIuYyIsImlhdCI6MSwiZXhwIjo5OTk5OTk5OTk5fQ." +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  check(
    "rejects a token signed with the wrong key",
    await connect(forged).then(() => false).catch(() => true),
  );

  const dupEmail = `dup${stamp}@probe.local`;
  const dup1 = await post("/api/auth/register", {
    email: dupEmail, password: "probetest1234",
    username: `dup${stamp}`, gender: "male", country: "IN",
  });
  const dup2 = await post("/api/auth/register", {
    email: dupEmail, password: "probetest1234",
    username: `dup${stamp}x`, gender: "male", country: "IN",
  });
  check("refuses a duplicate email", dup1.ok && !dup2.ok, `second: HTTP ${dup2.status}`);

  const weak = await post("/api/auth/register", {
    email: `weak${stamp}@probe.local`, password: "x",
    username: `weak${stamp}`, gender: "male", country: "IN",
  });
  check("refuses a trivially short password", !weak.ok, `HTTP ${weak.status}`);

  const badCountry = await post("/api/auth/register", {
    email: `bc${stamp}@probe.local`, password: "probetest1234",
    username: `bc${stamp}`, gender: "male", country: "NOTACOUNTRY",
  });
  check("refuses an invalid country", !badCountry.ok, `HTTP ${badCountry.status}`);

  const badGender = await post("/api/auth/register", {
    email: `bg${stamp}@probe.local`, password: "probetest1234",
    username: `bg${stamp}`, gender: "notagender", country: "IN",
  });
  check("refuses an unknown gender", !badGender.ok, `HTTP ${badGender.status}`);

  console.log("\n  --- authorisation ---");
  const alice = await register("a");
  const bob = await register("b", { gender: "female", country: "DE" });
  const mallory = await register("m");

  const noAuth = await fetch(`${BASE}/api/rtc/ice-servers`);
  check("ICE servers need a token", noAuth.status === 401, `HTTP ${noAuth.status}`);

  const report = await fetch(`${BASE}/api/meta/queue-report`);
  check("queue report needs a token", report.status === 401, `HTTP ${report.status}`);

  const sa = await connect(alice.token);
  const sb = await connect(bob.token);
  const sm = await connect(mallory.token);

  console.log("\n  --- matching ---");
  sa.emit("join-queue", { gender: "any", countries: [], city: null });
  const first = await queued(sa);
  if (first.how !== "queued") {
    console.log("\n  SKIP  someone else was already waiting; re-run when idle\n");
    sa.close();
    sb.close();
    sm.close();
    process.exit(0);
  }

  const matchA = once(sa, "match-found");
  const matchB = once(sb, "match-found");
  sb.emit("join-queue", { gender: "any", countries: [], city: null });
  const [ra, rb] = await Promise.all([matchA, matchB]);
  check("two waiting users are paired", Boolean(ra && rb) && ra.roomId === rb.roomId);
  const roomId = ra.roomId;

  console.log("\n  --- room isolation ---");
  const injected = "I should not be able to send this";
  const leaked = once(sb, "chat-message", 2500);
  sm.emit("chat-message", { roomId, text: injected });
  const gotLeak = await leaked;
  check(
    "an outsider cannot inject chat into a room",
    gotLeak === null || gotLeak.text !== injected,
  );

  const signalLeak = once(sb, "offer", 2500);
  sm.emit("offer", { roomId, offer: { type: "offer", sdp: "malicious" } });
  check("an outsider cannot inject signalling", (await signalLeak) === null);

  const teardown = once(sb, "partner-left", 2500);
  sm.emit("skip", { roomId });
  check("an outsider cannot end someone else's chat", (await teardown) === null);

  console.log("\n  --- input handling ---");
  // Stored as text and rendered as text. The server should not mangle it —
  // escaping belongs at the point of render, and React does that already.
  const markup = '<img src=x onerror="alert(1)">';
  const markupEcho = once(sb, "chat-message");
  sa.emit("chat-message", { roomId, text: markup });
  const markupMsg = await markupEcho;
  check("markup travels as text, unmodified", markupMsg?.text === markup);

  const longEcho = once(sb, "chat-message", 4000);
  sa.emit("chat-message", { roomId, text: "x".repeat(50_000) });
  const longMsg = await longEcho;
  check(
    "an oversized message is refused or clipped",
    longMsg === null || longMsg.text.length <= 1000,
    longMsg ? `${longMsg.text.length} chars` : "dropped",
  );

  const blankEcho = once(sb, "chat-message", 2000);
  sa.emit("chat-message", { roomId, text: "   " });
  check("whitespace-only messages are dropped", (await blankEcho) === null);

  const junkEcho = once(sb, "chat-message", 2000);
  sa.emit("chat-message", { roomId: null, text: 12345 });
  check("a malformed payload is ignored", (await junkEcho) === null);

  const unknownRoom = once(sb, "chat-message", 2000);
  sa.emit("chat-message", { roomId: "00000000-0000-0000-0000-000000000000", text: "hi" });
  check("a message to a room that does not exist goes nowhere", (await unknownRoom) === null);

  console.log("\n  --- still standing ---");
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check("server survived every probe", health.status === "ok", `store=${health.store}`);

  sa.close();
  sb.close();
  sm.close();

  console.log(
    `\n${failures === 0 ? `All ${total} probes passed.` : `${failures} of ${total} FAILED.`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nprobe error: ${err.message}\n`);
  process.exit(1);
});
