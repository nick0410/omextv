import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import { io as createClient, Socket as ClientSocket } from "socket.io-client";

import { prisma } from "../config/database";
import { env } from "../config/env";
import { setupSocket, shutdownSocket, getStats } from "../services/socket";
import { stores } from "../services/store";
import { isDbReady } from "./dbAvailable";
import { Gender } from "../types";

let server: http.Server;
let port: number;
const createdUserIds: string[] = [];

/** Every test user gets this prefix so cleanup can never touch real rows. */
const PREFIX = `itest_${Date.now()}_`;
let userSeq = 0;

interface TestUser {
  id: string;
  username: string;
  token: string;
}

async function makeUser(opts: {
  gender?: Gender;
  country?: string | null;
  city?: string | null;
  isPremium?: boolean;
  isBanned?: boolean;
  bannedUntil?: Date | null;
  verifiedGender?: string | null;
  genderConfidence?: number | null;
  genderVerifiedAt?: Date | null;
} = {}): Promise<TestUser> {
  const n = ++userSeq;
  const username = `${PREFIX}${n}`;
  const user = await prisma.user.create({
    data: {
      email: `${username}@test.local`,
      passwordHash: "x",
      username,
      gender: opts.gender ?? "male",
      country: opts.country === undefined ? "US" : opts.country,
      city: opts.city ?? null,
      isPremium: opts.isPremium ?? false,
      isBanned: opts.isBanned ?? false,
      bannedUntil: opts.bannedUntil ?? null,
      verifiedGender: opts.verifiedGender ?? null,
      genderConfidence: opts.genderConfidence ?? null,
      genderVerifiedAt: opts.genderVerifiedAt ?? null,
    },
    select: { id: true, username: true, email: true },
  });
  createdUserIds.push(user.id);

  return {
    id: user.id,
    username: user.username,
    token: jwt.sign({ userId: user.id, email: user.email }, env.JWT_SECRET, {
      expiresIn: "1h",
    }),
  };
}

const openSockets: ClientSocket[] = [];

/**
 * Every event a socket has received but no test has consumed yet.
 *
 * The server emits `connected` (and `chat-resumed`) from inside its connection
 * handler, which lands at essentially the same moment as the client's own
 * `connect` event. A test that awaits the connection and only then attaches a
 * listener would miss those payloads entirely. Buffering with `onAny` from the
 * instant the socket is created removes that race for every event, so tests do
 * not have to guess which ones are emitted eagerly.
 */
const inbox = new WeakMap<ClientSocket, Map<string, unknown[]>>();

function buffered(socket: ClientSocket): Map<string, unknown[]> {
  let box = inbox.get(socket);
  if (!box) {
    box = new Map();
    inbox.set(socket, box);
  }
  return box;
}

function connect(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(`http://localhost:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });
    openSockets.push(socket);

    const box = buffered(socket);
    socket.onAny((event: string, payload: unknown) => {
      const queue = box.get(event) ?? [];
      queue.push(payload);
      box.set(event, queue);
    });

    const timer = setTimeout(() => reject(new Error("connect timed out")), 5_000);
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

/** Wait for one event, rejecting on timeout so a hang fails loudly. */
function once<T = unknown>(socket: ClientSocket, event: string, ms = 3_000): Promise<T> {
  const box = buffered(socket);
  const pending = box.get(event);
  if (pending && pending.length > 0) {
    return Promise.resolve(pending.shift() as T);
  }

  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const queue = box.get(event);
      if (queue && queue.length > 0) {
        clearInterval(timer);
        clearTimeout(deadline);
        resolve(queue.shift() as T);
      }
    }, 5);

    const deadline = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`timed out waiting for "${event}"`));
    }, ms);
  });
}

/** Assert an event does NOT arrive within the window. */
function never(socket: ClientSocket, event: string, ms = 400): Promise<void> {
  const box = buffered(socket);
  // Anything already sitting in the buffer counts as having arrived.
  const existing = box.get(event);
  if (existing && existing.length > 0) {
    return Promise.reject(new Error(`unexpected "${event}" (already buffered)`));
  }

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const queue = box.get(event);
      if (queue && queue.length > 0) reject(new Error(`unexpected "${event}"`));
      else resolve();
    }, ms);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = http.createServer();
  setupSocket(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of openSockets) s.close();
  await shutdownSocket();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (createdUserIds.length > 0) {
    await prisma.chatSession.deleteMany({
      where: { OR: [{ userAId: { in: createdUserIds } }, { userBId: { in: createdUserIds } }] },
    });
    await prisma.block.deleteMany({
      where: { OR: [{ blockerId: { in: createdUserIds } }, { blockedId: { in: createdUserIds } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  // The socket layer talks to the configured store, so the tests must inspect
  // and reset the same thing rather than the raw in-process registries.
  await stores().queue.clear();
  await stores().pairing.clear();
});

afterEach(() => {
  while (openSockets.length > 0) openSockets.pop()!.close();
});

describe.skipIf(!isDbReady())("authentication", () => {
  it("rejects a connection with no token", async () => {
    await expect(connect("")).rejects.toThrow();
  });

  it("rejects a forged token", async () => {
    const bad = jwt.sign({ userId: "nope", email: "x@y.z" }, "wrong-secret");
    await expect(connect(bad)).rejects.toThrow();
  });

  it("rejects a token for a deleted user", async () => {
    const token = jwt.sign({ userId: "does-not-exist", email: "x@y.z" }, env.JWT_SECRET);
    await expect(connect(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const user = await makeUser();
    const expired = jwt.sign({ userId: user.id, email: "x@y.z" }, env.JWT_SECRET, {
      expiresIn: "-1s",
    });
    await expect(connect(expired)).rejects.toThrow();
  });

  it("rejects a banned account", async () => {
    const user = await makeUser({ isBanned: true, bannedUntil: new Date(Date.now() + 60_000) });
    await expect(connect(user.token)).rejects.toThrow();
  });

  it("lets an expired ban through and clears it", async () => {
    const user = await makeUser({ isBanned: true, bannedUntil: new Date(Date.now() - 60_000) });
    const socket = await connect(user.token);
    expect(socket.connected).toBe(true);

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { isBanned: true },
    });
    expect(row!.isBanned).toBe(false);
  });

  it("accepts a valid token and greets the client", async () => {
    const user = await makeUser();
    const socket = await connect(user.token);
    const hello = await once<{ userId: string; username: string }>(socket, "connected");
    expect(hello.userId).toBe(user.id);
    expect(hello.username).toBe(user.username);
  });
});

describe.skipIf(!isDbReady())("single session per account", () => {
  it("evicts the older socket when the same user connects twice", async () => {
    const user = await makeUser();
    const first = await connect(user.token);
    await once(first, "connected");

    const replaced = once<{ reason: string }>(first, "session-replaced");
    const second = await connect(user.token);
    await once(second, "connected");

    const payload = await replaced;
    expect(payload.reason).toBe("signed_in_elsewhere");
    await sleep(100);
    expect(first.connected).toBe(false);
    expect(second.connected).toBe(true);
    expect(await stores().presence.onlineCount()).toBe(1);
  });
});

describe.skipIf(!isDbReady())("matchmaking", () => {
  it("queues the first user and matches the second", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const sa = await connect(a.token);
    await once(sa, "connected");

    sa.emit("join-queue", {});
    const queued = await once<{ position: number }>(sa, "queue-joined");
    expect(queued.position).toBe(1);

    const sb = await connect(b.token);
    await once(sb, "connected");

    const matchA = once<{ roomId: string; isInitiator: boolean; partner: { userId: string } }>(sa, "match-found");
    const matchB = once<{ roomId: string; isInitiator: boolean; partner: { userId: string } }>(sb, "match-found");
    sb.emit("join-queue", {});

    const [ra, rb] = await Promise.all([matchA, matchB]);
    expect(ra.roomId).toBe(rb.roomId);
    expect(ra.partner.userId).toBe(b.id);
    expect(rb.partner.userId).toBe(a.id);
    // Exactly one initiator, so the two peers cannot glare.
    expect(ra.isInitiator).not.toBe(rb.isInitiator);
  });

  it("never leaks the partner's email", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    await Promise.all([once(sa, "connected"), once(sb, "connected")]);

    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    const matched = once<{ partner: Record<string, unknown> }>(sb, "match-found");
    sb.emit("join-queue", {});

    const payload = await matched;
    expect(payload.partner).not.toHaveProperty("email");
    expect(JSON.stringify(payload)).not.toContain("@test.local");
  });

  it("writes a ChatSession row when a pair forms", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    await Promise.all([once(sa, "connected"), once(sb, "connected")]);

    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    const matchedB = once<{ roomId: string }>(sb, "match-found");
    const matchedA = once<{ roomId: string }>(sa, "match-found");
    sb.emit("join-queue", {});
    // Both sides must be consumed, else the leftover payload sits in the
    // buffer and a later never("match-found") assertion trips on it.
    const [{ roomId }] = await Promise.all([matchedB, matchedA]);

    await sleep(200);
    const row = await prisma.chatSession.findUnique({ where: { roomId } });
    expect(row).not.toBeNull();
    expect([row!.userAId, row!.userBId].sort()).toEqual([a.id, b.id].sort());
  });

  it("refuses to queue while already in a chat", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    await Promise.all([once(sa, "connected"), once(sb, "connected")]);

    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    const matched = once(sa, "match-found");
    sb.emit("join-queue", {});
    await matched;

    sa.emit("join-queue", {});
    const err = await once<{ code: string }>(sa, "queue-error");
    expect(err.code).toBe("already_in_chat");
  });

  it("leave-queue removes the user", async () => {
    const a = await makeUser();
    const sa = await connect(a.token);
    await once(sa, "connected");

    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    sa.emit("leave-queue");

    const left = await once<{ wasQueued: boolean }>(sa, "queue-left");
    expect(left.wasQueued).toBe(true);
    expect(await stores().queue.size()).toBe(0);
  });

  it("respects a country filter and does not mismatch", async () => {
    // Premium, because a country filter is premium-only now — a free account's
    // would be cleared before the matcher ever saw it, and this test would
    // pass by matching everyone rather than by filtering correctly.
    const jp = await makeUser({ country: "JP", isPremium: true });
    const br = await makeUser({ country: "BR" });

    const sjp = await connect(jp.token);
    const sbr = await connect(br.token);
    await Promise.all([once(sjp, "connected"), once(sbr, "connected")]);

    // JP will only talk to someone in India.
    sjp.emit("join-queue", { countries: ["IN"] });
    await once(sjp, "queue-joined");

    sbr.emit("join-queue", {});
    await once(sbr, "queue-joined");

    // Neither should be matched with the other.
    await never(sjp, "match-found", 500);
    expect(await stores().queue.size()).toBe(2);
  });

  it("matches when both country filters agree", async () => {
    const jp = await makeUser({ country: "JP", isPremium: true });
    const inUser = await makeUser({ country: "IN", isPremium: true });

    const sjp = await connect(jp.token);
    const sin = await connect(inUser.token);
    await Promise.all([once(sjp, "connected"), once(sin, "connected")]);

    sjp.emit("join-queue", { countries: ["IN"] });
    await once(sjp, "queue-joined");

    const matched = once<{ partner: { country: string } }>(sin, "match-found");
    sin.emit("join-queue", { countries: ["JP"] });

    expect((await matched).partner.country).toBe("JP");
  });

  it("respects a gender filter in both directions", async () => {
    const man = await makeUser({ gender: "male", isPremium: true });
    const otherMan = await makeUser({ gender: "male", isPremium: true });

    const s1 = await connect(man.token);
    const s2 = await connect(otherMan.token);
    await Promise.all([once(s1, "connected"), once(s2, "connected")]);

    s1.emit("join-queue", { gender: "female" });
    await once(s1, "queue-joined");
    s2.emit("join-queue", { gender: "female" });
    await once(s2, "queue-joined");

    await never(s1, "match-found", 500);
  });

  it("matches on the verified gender rather than the declared one", async () => {
    // Declares male, but a fresh confident reading says female.
    const declaredMale = await makeUser({
      gender: "male",
      verifiedGender: "female",
      genderConfidence: 0.95,
      genderVerifiedAt: new Date(),
    });
    const seeker = await makeUser({ gender: "male", isPremium: true });

    const s1 = await connect(declaredMale.token);
    const s2 = await connect(seeker.token);
    await Promise.all([once(s1, "connected"), once(s2, "connected")]);

    s1.emit("join-queue", {});
    await once(s1, "queue-joined");

    const matched = once<{ partner: { gender: string; genderVerified: boolean } }>(
      s2,
      "match-found",
    );
    s2.emit("join-queue", { gender: "female" });

    const payload = await matched;
    expect(payload.partner.gender).toBe("female");
    expect(payload.partner.genderVerified).toBe(true);
  });

  it("ignores a stale verification and falls back to the declared gender", async () => {
    const stale = await makeUser({
      gender: "male",
      verifiedGender: "female",
      genderConfidence: 0.95,
      genderVerifiedAt: new Date(Date.now() - 48 * 60 * 60_000),
    });
    const seeker = await makeUser({ gender: "male", isPremium: true });

    const s1 = await connect(stale.token);
    const s2 = await connect(seeker.token);
    await Promise.all([once(s1, "connected"), once(s2, "connected")]);

    s1.emit("join-queue", {});
    await once(s1, "queue-joined");
    s2.emit("join-queue", { gender: "female" });
    await once(s2, "queue-joined");

    // The stale reading must not make him matchable as female.
    await never(s2, "match-found", 500);
  });

  it("puts a premium user ahead of an older standard waiter", async () => {
    const std = await makeUser({ gender: "male" });
    const prem = await makeUser({ gender: "male", isPremium: true });
    const woman = await makeUser({ gender: "female", isPremium: true });

    /*
     * Kept apart by a block, not by a filter.
     *
     * The two men used to each ask for women, which is what stopped them
     * pairing with each other. A gender filter is premium-only now, so the
     * standard waiter cannot express that at all — his filter would be cleared
     * and he would pair with the premium user immediately, and the test would
     * be measuring nothing. A block is free, applies in both directions, and
     * holds them both in the queue for the same reason.
     */
    await prisma.block.create({ data: { blockerId: std.id, blockedId: prem.id } });

    const sStd = await connect(std.token);
    const sPrem = await connect(prem.token);
    const sW = await connect(woman.token);
    await Promise.all([once(sStd, "connected"), once(sPrem, "connected"), once(sW, "connected")]);

    sStd.emit("join-queue", {});
    await once(sStd, "queue-joined");
    sPrem.emit("join-queue", {});
    await once(sPrem, "queue-joined");

    const matched = once<{ partner: { userId: string } }>(sW, "match-found");
    sW.emit("join-queue", { gender: "male" });

    expect((await matched).partner.userId).toBe(prem.id);
  });

  it("ignores the filters a free account sends, and says so", async () => {
    // The paywall, where it actually lives. The panel disables these controls,
    // but the payload arrives over a socket and can be sent by hand.
    const man = await makeUser({ gender: "male", country: "JP" });
    const otherMan = await makeUser({ gender: "male", country: "BR" });

    const s1 = await connect(man.token);
    const s2 = await connect(otherMan.token);
    await Promise.all([once(s1, "connected"), once(s2, "connected")]);

    const told = once<{ dropped: string[] }>(s1, "filters-restricted");
    s1.emit("join-queue", { gender: "female", countries: ["IN"] });

    expect((await told).dropped).toEqual(["gender", "country"]);

    // And the search went ahead rather than failing: two men who each asked
    // for women in India are matched with each other.
    const matched = once(s1, "match-found");
    s2.emit("join-queue", {});
    expect(await matched).toBeTruthy();
  });

  it("says nothing when a free account asked for nothing", async () => {
    const a = await makeUser();
    const sa = await connect(a.token);
    await once(sa, "connected");

    sa.emit("join-queue", {});
    await once(sa, "queue-joined");

    // A notice on every plain join would be noise, and would train people to
    // ignore the one that matters.
    await never(sa, "filters-restricted", 300);
  });

  it("re-queues the survivor when the partner vanishes before the match lands", async () => {
    const a = await makeUser();
    const b = await makeUser();

    const sa = await connect(a.token);
    await once(sa, "connected");
    sa.emit("join-queue", {});
    await once(sa, "queue-joined");

    // B joins the queue directly, then disappears before anyone matches it.
    const sb = await connect(b.token);
    await once(sb, "connected");
    sa.emit("leave-queue");
    await once(sa, "queue-left");

    sb.emit("join-queue", {});
    await once(sb, "queue-joined");
    sb.disconnect();
    await sleep(150);

    // A rejoins; B's entry is gone, so A simply waits.
    sa.emit("join-queue", {});
    const res = await once<{ position: number }>(sa, "queue-joined");
    expect(res.position).toBe(1);
  });
});

describe.skipIf(!isDbReady())("room security", () => {
  async function pairUp() {
    const [a, b] = [await makeUser(), await makeUser()];
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    await Promise.all([once(sa, "connected"), once(sb, "connected")]);

    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    const matchedB = once<{ roomId: string }>(sb, "match-found");
    const matchedA = once<{ roomId: string }>(sa, "match-found");
    sb.emit("join-queue", {});
    // Both sides must be consumed, else the leftover payload sits in the
    // buffer and a later never("match-found") assertion trips on it.
    const [{ roomId }] = await Promise.all([matchedB, matchedA]);
    return { a, b, sa, sb, roomId };
  }

  it("relays an offer between the two members", async () => {
    const { sa, sb, roomId } = await pairUp();
    const incoming = once<{ offer: string; from: string }>(sb, "offer");
    sa.emit("offer", { roomId, offer: "sdp-here" });
    expect((await incoming).offer).toBe("sdp-here");
  });

  it("rejects signalling into a room the sender is not in", async () => {
    const { roomId } = await pairUp();
    const outsider = await makeUser();
    const so = await connect(outsider.token);
    await once(so, "connected");

    so.emit("offer", { roomId, offer: "malicious" });
    const rejected = await once<{ code: string }>(so, "signal-rejected");
    expect(rejected.code).toBe("not_a_member");
  });

  it("does not deliver an outsider's message to the room", async () => {
    const { sb, roomId } = await pairUp();
    const outsider = await makeUser();
    const so = await connect(outsider.token);
    await once(so, "connected");

    const leaked = never(sb, "chat-message", 500);
    so.emit("chat-message", { roomId, text: "injected" });
    await expect(leaked).resolves.toBeUndefined();
  });

  it("rejects a chat message from a non-member", async () => {
    const { roomId } = await pairUp();
    const outsider = await makeUser();
    const so = await connect(outsider.token);
    await once(so, "connected");

    so.emit("chat-message", { roomId, text: "hello" });
    expect((await once<{ code: string }>(so, "message-rejected")).code).toBe("not_a_member");
  });

  it("ignores signalling with a malformed payload", async () => {
    const { sa } = await pairUp();
    expect(() => {
      sa.emit("offer", "not-an-object");
      sa.emit("offer", null);
      sa.emit("ice-candidate", { roomId: 42 });
    }).not.toThrow();
    await sleep(150);
    expect(sa.connected).toBe(true);
  });
});

describe.skipIf(!isDbReady())("chat messages", () => {
  async function pairUp() {
    const [a, b] = [await makeUser(), await makeUser()];
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    await Promise.all([once(sa, "connected"), once(sb, "connected")]);
    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    const matchedB = once<{ roomId: string }>(sb, "match-found");
    const matchedA = once<{ roomId: string }>(sa, "match-found");
    sb.emit("join-queue", {});
    // Both sides must be consumed, else the leftover payload sits in the
    // buffer and a later never("match-found") assertion trips on it.
    const [{ roomId }] = await Promise.all([matchedB, matchedA]);
    return { a, b, sa, sb, roomId };
  }

  it("delivers a message to both participants", async () => {
    const { sa, sb, roomId, a } = await pairUp();
    const atB = once<{ text: string; senderId: string }>(sb, "chat-message");
    const atA = once<{ text: string }>(sa, "chat-message");
    sa.emit("chat-message", { roomId, text: "hello there" });

    const [rb, ra] = await Promise.all([atB, atA]);
    expect(rb.text).toBe("hello there");
    expect(rb.senderId).toBe(a.id);
    expect(ra.text).toBe("hello there");
  });

  it("truncates an over-long message instead of dropping it", async () => {
    const { sa, sb, roomId } = await pairUp();
    const incoming = once<{ text: string }>(sb, "chat-message");
    sa.emit("chat-message", { roomId, text: "x".repeat(5000) });
    expect((await incoming).text.length).toBe(env.MAX_MESSAGE_LENGTH);
  });

  it("ignores an empty or whitespace-only message", async () => {
    const { sa, sb, roomId } = await pairUp();
    const nothing = never(sb, "chat-message", 400);
    sa.emit("chat-message", { roomId, text: "   " });
    sa.emit("chat-message", { roomId, text: "" });
    await expect(nothing).resolves.toBeUndefined();
  });

  it("counts messages on the persisted session", async () => {
    const { sa, sb, roomId } = await pairUp();
    for (let i = 0; i < 3; i++) {
      const got = once(sb, "chat-message");
      sa.emit("chat-message", { roomId, text: `msg ${i}` });
      await got;
    }
    expect((await stores().pairing.pairByRoom(roomId))?.messageCount).toBe(3);
  });

  it("relays typing indicators only to the partner", async () => {
    const { sa, sb, roomId, a } = await pairUp();
    const typing = once<{ userId: string; isTyping: boolean }>(sb, "typing");
    sa.emit("typing", { roomId, isTyping: true });
    const payload = await typing;
    expect(payload.userId).toBe(a.id);
    expect(payload.isTyping).toBe(true);
  });
});

describe.skipIf(!isDbReady())("leaving a chat", () => {
  async function pairUp() {
    const [a, b] = [await makeUser(), await makeUser()];
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    await Promise.all([once(sa, "connected"), once(sb, "connected")]);
    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    const matchedB = once<{ roomId: string }>(sb, "match-found");
    const matchedA = once<{ roomId: string }>(sa, "match-found");
    sb.emit("join-queue", {});
    // Both sides must be consumed, else the leftover payload sits in the
    // buffer and a later never("match-found") assertion trips on it.
    const [{ roomId }] = await Promise.all([matchedB, matchedA]);
    return { a, b, sa, sb, roomId };
  }

  it("skip notifies the partner and frees both users", async () => {
    const { sa, sb, roomId } = await pairUp();
    const partnerLeft = once<{ reason: string }>(sb, "partner-left");
    const ended = once<{ reason: string }>(sa, "chat-ended");
    sa.emit("skip", { roomId });

    expect((await partnerLeft).reason).toBe("skip");
    expect((await ended).reason).toBe("skip");
    expect(await stores().pairing.pairByRoom(roomId)).toBeNull();
  });

  it("end-chat behaves the same with its own reason", async () => {
    const { sa, sb, roomId } = await pairUp();
    const partnerLeft = once<{ reason: string }>(sb, "partner-left");
    sa.emit("end-chat", { roomId });
    expect((await partnerLeft).reason).toBe("end");
  });

  it("persists the end reason and duration", async () => {
    const { sa, sb, roomId } = await pairUp();
    const left = once(sb, "partner-left");
    sa.emit("skip", { roomId });
    await left;
    await sleep(200);

    const row = await prisma.chatSession.findUnique({ where: { roomId } });
    expect(row!.endReason).toBe("skip");
    expect(row!.endedAt).not.toBeNull();
    expect(row!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("ignores a skip naming somebody else's room", async () => {
    const { sa, sb } = await pairUp();
    const nothing = never(sb, "partner-left", 400);
    sa.emit("skip", { roomId: "some-other-room" });
    await expect(nothing).resolves.toBeUndefined();
  });

  it("skipping when not in a chat is harmless", async () => {
    const a = await makeUser();
    const sa = await connect(a.token);
    await once(sa, "connected");
    sa.emit("skip", {});
    const ended = await once<{ roomId: string | null }>(sa, "chat-ended");
    expect(ended.roomId).toBeNull();
  });

  it("does not immediately rematch the two people who just skipped", async () => {
    const { sa, sb, roomId } = await pairUp();
    const left = once(sb, "partner-left");
    sa.emit("skip", { roomId });
    await left;

    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    sb.emit("join-queue", {});
    await once(sb, "queue-joined");

    await never(sa, "match-found", 600);
    expect(await stores().queue.size()).toBe(2);
  });
});

describe.skipIf(!isDbReady())("disconnects", () => {
  async function pairUp() {
    const [a, b] = [await makeUser(), await makeUser()];
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    await Promise.all([once(sa, "connected"), once(sb, "connected")]);
    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    const matchedB = once<{ roomId: string }>(sb, "match-found");
    const matchedA = once<{ roomId: string }>(sa, "match-found");
    sb.emit("join-queue", {});
    // Both sides must be consumed, else the leftover payload sits in the
    // buffer and a later never("match-found") assertion trips on it.
    const [{ roomId }] = await Promise.all([matchedB, matchedA]);
    return { a, b, sa, sb, roomId };
  }

  it("removes a queued user from the queue", async () => {
    const a = await makeUser();
    const sa = await connect(a.token);
    await once(sa, "connected");
    sa.emit("join-queue", {});
    await once(sa, "queue-joined");
    expect(await stores().queue.size()).toBe(1);

    sa.disconnect();
    await sleep(150);
    expect(await stores().queue.size()).toBe(0);
  });

  it("warns the partner and holds the room during the grace period", async () => {
    const { sa, sb, roomId } = await pairUp();
    const warned = once<{ graceMs: number }>(sb, "partner-connection-lost");
    sa.disconnect();

    expect((await warned).graceMs).toBe(env.RECONNECT_GRACE_MS);
    // Still paired while the grace window is open.
    expect(await stores().pairing.pairByRoom(roomId)).not.toBeNull();
  });

  it("ends the chat once the grace period lapses", async () => {
    const { sa, sb, roomId } = await pairUp();
    const warned = once(sb, "partner-connection-lost");
    const gone = once<{ reason: string }>(sb, "partner-left", 3_000);
    sa.disconnect();
    await warned;

    expect((await gone).reason).toBe("disconnect");
    expect(await stores().pairing.pairByRoom(roomId)).toBeNull();
  });

  it("restores the chat when the user reconnects in time", async () => {
    const { a, sa, sb, roomId } = await pairUp();
    const warned = once(sb, "partner-connection-lost");
    sa.disconnect();
    await warned;

    const reconnected = once<{ roomId: string }>(sb, "partner-reconnected");
    const s2 = await connect(a.token);
    const resumed = await once<{ roomId: string }>(s2, "chat-resumed");

    expect(resumed.roomId).toBe(roomId);
    expect((await reconnected).roomId).toBe(roomId);
    expect(await stores().pairing.pairByRoom(roomId)).not.toBeNull();
    // The pending teardown must have been cancelled.
    await never(sb, "partner-left", 600);
  });
});

describe.skipIf(!isDbReady())("gender verification over the socket", () => {
  it("acknowledges a verification attempt", async () => {
    const user = await makeUser();
    const socket = await connect(user.token);
    await once(socket, "connected");

    // The mock provider is deterministic; this image yields a usable face.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 5, 0xff, 0xd9]);
    socket.emit("verify-gender", { image: jpeg.toString("base64") });

    const res = await once<{ ok: boolean; outcome: string }>(socket, "gender-verified");
    expect(typeof res.ok).toBe("boolean");
    expect([
      "accepted",
      "low_confidence",
      "no_face",
      "multiple_faces",
    ]).toContain(res.outcome);
  });

  it("rejects a payload that is not an image", async () => {
    const user = await makeUser();
    const socket = await connect(user.token);
    await once(socket, "connected");

    socket.emit("verify-gender", { image: "definitely-not-base64-jpeg" });
    const res = await once<{ ok: boolean; outcome: string }>(socket, "gender-verified");
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("invalid_image");
  });

  it("rejects a malformed event payload", async () => {
    const user = await makeUser();
    const socket = await connect(user.token);
    await once(socket, "connected");

    socket.emit("verify-gender", {});
    const res = await once<{ outcome: string }>(socket, "gender-verified");
    expect(res.outcome).toBe("invalid_image");
  });
});

describe.skipIf(!isDbReady())("stats", () => {
  it("reports live queue and chat counts", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const sa = await connect(a.token);
    await once(sa, "connected");
    sa.emit("join-queue", {});
    await once(sa, "queue-joined");

    let stats = await getStats();
    expect(stats.queued).toBe(1);
    expect(stats.activeChats).toBe(0);

    const sb = await connect(b.token);
    await once(sb, "connected");
    const matched = once(sb, "match-found");
    sb.emit("join-queue", {});
    await matched;

    stats = await getStats();
    expect(stats.queued).toBe(0);
    expect(stats.activeChats).toBe(1);
    expect(stats.online).toBeGreaterThanOrEqual(2);
  });

  it("reports the queue position on demand", async () => {
    const a = await makeUser();
    const sa = await connect(a.token);
    await once(sa, "connected");
    sa.emit("join-queue", {});
    await once(sa, "queue-joined");

    sa.emit("queue-status");
    const status = await once<{ position: number; size: number }>(sa, "queue-status");
    expect(status.position).toBe(1);
    expect(status.size).toBe(1);
  });
  /*
   * The earliest a client can possibly speak.
   *
   * Every other test here waits for "connected" before emitting, which quietly
   * sidesteps the window this covers: the client's own "connect" fires as soon
   * as the transport is up, while the server is still awaiting Redis inside
   * its connection handler. The handlers used to be attached only after those
   * awaits, and socket.io discards an event with no listener — so a join sent
   * this early vanished. No error reached the client and no entry reached the
   * queue; the user simply searched forever. It cost about one user in six
   * when six joined at once.
   */
  it("does not lose a join sent the instant the socket connects", async () => {
    const a = await makeUser();

    const socket = createClient(`http://localhost:${port}`, {
      auth: { token: a.token },
      transports: ["websocket"],
      reconnection: false,
    });
    openSockets.push(socket);

    const box = buffered(socket);
    socket.onAny((event: string, payload: unknown) => {
      const queue = box.get(event) ?? [];
      queue.push(payload);
      box.set(event, queue);
    });

    // Synchronously, in the same tick the transport opens — no awaiting
    // "connected" first, which is the whole point.
    socket.on("connect", () => socket.emit("join-queue", {}));

    await once(socket, "queue-joined");
    expect((await getStats()).queued).toBe(1);
  });
});
