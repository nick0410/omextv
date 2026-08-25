/**
 * Does connecting actually record that somebody was here?
 *
 * The column sat null for every account since the first migration because
 * nothing wrote to it. Checking the code compiles proves nothing about that;
 * this connects a real socket and reads the row back.
 */
import { io } from "socket.io-client";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const API = process.env.API ?? "http://localhost:3001";
const p = new PrismaClient();
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? "  ok  " : " FAIL "} ${label}`); if (!ok) failed++; };

// A throwaway account, so no real row is touched.
const email = `lastseen_${Date.now()}@probe.test`;
const user = await p.user.create({
  data: { email, passwordHash: "x", username: `ls_${Date.now()}`, gender: "male" },
  select: { id: true, email: true, lastSeenAt: true },
});
check(user.lastSeenAt === null, "starts null");

const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "5m" });
const socket = io(API, { auth: { token }, transports: ["websocket"] });

await new Promise((resolve, reject) => {
  socket.on("connected", resolve);
  socket.on("connect_error", reject);
  setTimeout(() => reject(new Error("timed out")), 10_000);
});

// The write is deliberately not awaited by the server, so give it a moment.
await new Promise((r) => setTimeout(r, 1500));

const after = await p.user.findUnique({ where: { id: user.id }, select: { lastSeenAt: true } });
check(after.lastSeenAt !== null, `written on connect (${after.lastSeenAt?.toISOString() ?? "null"})`);

// Reconnecting must not write again — that is the throttle.
const first = after.lastSeenAt;
socket.disconnect();
const again = io(API, { auth: { token }, transports: ["websocket"] });
await new Promise((resolve, reject) => {
  again.on("connected", resolve);
  again.on("connect_error", reject);
  setTimeout(() => reject(new Error("timed out")), 10_000);
});
await new Promise((r) => setTimeout(r, 1500));

const third = await p.user.findUnique({ where: { id: user.id }, select: { lastSeenAt: true } });
check(third.lastSeenAt?.getTime() === first?.getTime(), "throttled: a reconnect does not write again");

again.disconnect();
await p.user.delete({ where: { id: user.id } });
await p.$disconnect();

console.log(failed === 0 ? "\nAll checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
