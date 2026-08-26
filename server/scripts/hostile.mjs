#!/usr/bin/env node
/**
 * Send every endpoint the things a real client never would.
 *
 * The happy paths are covered elsewhere. What is not is what happens when the
 * input is missing, the wrong type, enormous, or belongs to somebody else, and
 * those are where a 500 hides or, worse, where one account reaches another's
 * data.
 *
 * A 4xx is a pass: it means the case was considered. A 500, a hang, or a 200
 * where there should not be one is a finding.
 *
 *   node scripts/hostile.mjs [baseUrl]
 */
const BASE = process.argv[2] || "http://localhost:3001";

let findings = 0;
let checked = 0;

function ok(label, condition, detail = "") {
  checked++;
  if (!condition) {
    findings++;
    console.log(`  FINDING  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const stamp = Date.now().toString(36);
let seq = 0;

async function call(path, { method = "GET", token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  const text = await res.text();
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}

async function register(over = {}) {
  const name = `hos${stamp}${seq++}`;
  return call("/api/auth/register", {
    method: "POST",
    body: {
      email: `${name}@probe.test`,
      password: "hostileprobe1234",
      username: name,
      gender: "male",
      country: "IN",
      ...over,
    },
  });
}

async function main() {
  console.log(`\nHostile input against ${BASE}\n`);

  // --- unauthenticated access to things that need an account --------------
  for (const path of [
    "/api/user/profile",
    "/api/coins/me",
    "/api/rtc/ice-servers",
    "/api/admin/overview",
    "/api/report/blocks",
    "/api/meta/gender-status",
  ]) {
    const r = await call(path);
    ok(`GET ${path} without a token`, r.status === 401 || r.status === 403, `got ${r.status}`);
  }

  // --- malformed tokens ---------------------------------------------------
  for (const token of ["notatoken", "a.b.c", "Bearer", "null", "undefined", "x".repeat(4000)]) {
    const r = await call("/api/user/profile", { token });
    ok(`a junk token is refused (${token.slice(0, 12)})`,
      r.status === 401 || r.status === 403, `got ${r.status}`);
  }

  // --- registration validation -------------------------------------------
  const bad = [
    [{ email: "not-an-email" }, "a malformed address"],
    [{ password: "short" }, "a password below the minimum"],
    [{ username: "" }, "an empty username"],
    [{ username: "x".repeat(500) }, "an enormous username"],
    [{ gender: "banana" }, "a gender outside the set"],
    [{ email: "" }, "an empty address"],
    [{ email: "a".repeat(300) + "@x.com" }, "an enormous address"],
  ];
  for (const [over, label] of bad) {
    const r = await register(over);
    ok(`register rejects ${label}`, r.status >= 400 && r.status < 500, `got ${r.status}`);
  }

  // --- bodies that are not what the route expects -------------------------
  for (const raw of ["", "null", "[]", '"a string"', "{", '{"a":', "123"]) {
    const r = await call("/api/auth/login", { method: "POST", raw });
    ok(`login survives a body of ${JSON.stringify(raw).slice(0, 14)}`,
      r.status >= 400 && r.status < 500, `got ${r.status}`);
  }

  // --- a real account, then other people's things -------------------------
  const a = await register();
  const b = await register();
  ok("two accounts could be made", a.status === 201 && b.status === 201, `${a.status}/${b.status}`);
  if (a.status !== 201 || b.status !== 201) {
    console.log("\ncannot continue without accounts\n");
    process.exit(1);
  }

  const tokenA = a.body.token;
  const tokenB = b.body.token;
  const idA = a.body.user.id;
  const idB = b.body.user.id;

  ok("cannot block yourself",
    (await call("/api/report/block", { method: "POST", token: tokenA, body: { blockedId: idA } })).status === 400);
  ok("cannot block an account that does not exist",
    (await call("/api/report/block", { method: "POST", token: tokenA, body: { blockedId: "cl00000000000000000000000" } })).status === 404);
  const first = await call("/api/report/block", { method: "POST", token: tokenA, body: { blockedId: idB } });
  const again = await call("/api/report/block", { method: "POST", token: tokenA, body: { blockedId: idB } });
  ok("blocking twice is not an error", first.status === 201 && again.status === 201, `${first.status}/${again.status}`);

  const shortReason = await call("/api/report", {
    method: "POST", token: tokenA,
    body: { reportedId: idB, category: "spam", reason: "hi" },
  });
  ok("a report needs a real reason", shortReason.status === 400, `got ${shortReason.status}`);

  const selfReport = await call("/api/report", {
    method: "POST", token: tokenA,
    body: { reportedId: idA, category: "spam", reason: "reporting my own account here" },
  });
  ok("cannot report yourself", selfReport.status === 400, `got ${selfReport.status}`);

  // --- profile updates that would be a privilege grant ---------------------
  for (const [patch, label] of [
    [{ username: "" }, "an empty username"],
    [{ username: "x".repeat(500) }, "an enormous username"],
    [{ gender: "banana" }, "a gender outside the set"],
    [{ isPremium: true }, "granting itself premium"],
    [{ coins: 999999 }, "granting itself coins"],
    [{ isBanned: false }, "unbanning itself"],
  ]) {
    const r = await call("/api/user/profile", { method: "PATCH", token: tokenA, body: patch });
    ok(`profile update handles ${label}`, r.status < 500, `got ${r.status}`);
  }

  const me = await call("/api/coins/me", { token: tokenA });
  ok("coins were not self-granted", me.status === 200 && me.body.coins === 0, `coins=${me.body && me.body.coins}`);
  const prof = await call("/api/user/profile", { token: tokenA });
  const isPrem = prof.body && prof.body.user && prof.body.user.isPremium;
  ok("premium was not self-granted", prof.status === 200 && !isPrem, `isPremium=${isPrem}`);

  // --- orders --------------------------------------------------------------
  for (const [body, label] of [
    [{ packId: "nonexistent" }, "an unknown pack"],
    [{ packId: "" }, "an empty pack"],
    [{}, "no pack at all"],
    [{ packId: ["starter"] }, "a pack that is an array"],
  ]) {
    const r = await call("/api/coins/orders", { method: "POST", token: tokenA, body });
    ok(`ordering rejects ${label}`, r.status >= 400 && r.status < 500, `got ${r.status}`);
  }

  const mine = await call("/api/coins/orders", { method: "POST", token: tokenA, body: { packId: "starter" } });
  const orderId = mine.body && (mine.body.order ? mine.body.order.id : mine.body.id);
  ok("a valid order is accepted", mine.status === 200 || mine.status === 201, `got ${mine.status}`);
  if (orderId) {
    // A well-formed body on purpose. The earlier version sent the wrong field
    // name, was refused for that, and counted the refusal as proof that the
    // ownership check works -- which it never exercised.
    const good = { paymentRef: "UTR999888777666" };
    const stolen = await call(`/api/coins/orders/${orderId}/reference`, {
      method: "POST", token: tokenB, body: good,
    });
    ok("cannot attach a reference to someone else's order", stolen.status >= 400, `got ${stolen.status}`);

    // And the owner can, so the refusal above was about ownership and not
    // about the request being unacceptable to everyone.
    const owner = await call(`/api/coins/orders/${orderId}/reference`, {
      method: "POST", token: tokenA, body: good,
    });
    ok("the owner can attach the same reference", owner.status < 400, `got ${owner.status}`);
  }

  // --- routes that do not exist -------------------------------------------
  const missing = await call("/api/nope/nothing");
  ok("an unknown api route is a clean 404", missing.status === 404, `got ${missing.status}`);

  // --- hostile ids in a path parameter ------------------------------------
  //
  // Unblocking is idempotent by design: it reports how many rows went, and
  // none going is not an error. So what is checked is that a hostile id is
  // treated as an id that simply matches nothing -- no error, and above all no
  // deletion. Demanding a 4xx here was the probe misreading its own subject.
  for (const id of ["../../etc/passwd", "%2e%2e%2f", "'; DROP TABLE users;--", " "]) {
    const r = await call(`/api/report/block/${encodeURIComponent(id)}`, { method: "DELETE", token: tokenA });
    const removedNothing = r.status === 200 && r.body && r.body.removed === 0;
    ok(`a hostile id matches nothing (${id.slice(0, 12)})`, removedNothing, `got ${r.status} removed=${r.body && r.body.removed}`);
  }

  // The real block must still be there after all of that.
  const blocks = await call("/api/report/blocks", { token: tokenA });
  const stillBlocked = Array.isArray(blocks.body && blocks.body.blocks)
    ? blocks.body.blocks.some((x) => (x.userId) === idB)
    : null;
  ok("the genuine block survived the hostile ids", stillBlocked !== false, `blocks=${JSON.stringify(blocks.body).slice(0, 80)}`);

  console.log(
    `\n${findings === 0 ? `Nothing found in ${checked} checks.` : `${findings} finding(s) in ${checked} checks.`}\n`,
  );
  process.exit(findings === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}\n`);
  process.exitCode = 1;
});
