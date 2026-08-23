#!/usr/bin/env node
/**
 * Ask a TURN server for a relay allocation and report whether it gave one.
 *
 * Configuring a relay that cannot actually allocate is worse than having none:
 * every call pays the ICE gathering latency and still fails, while the UI
 * claims a relay is available. This performs the real RFC 5766 exchange —
 * unauthenticated Allocate, then a retry with the long-term credentials from
 * the 401 challenge — so "it works" is something observed, not assumed.
 *
 *   node scripts/turn-check.mjs turn:host:3478 [username] [password]
 */
import dgram from "node:dgram";
import crypto from "node:crypto";

const [rawUrl, username, password] = process.argv.slice(2);
if (!rawUrl) {
  console.error("usage: turn-check.mjs turn:host:port [username] [password]");
  process.exit(2);
}

const m = /^turns?:([^:?]+)(?::(\d+))?/.exec(rawUrl);
if (!m) {
  console.error(`not a turn: URL — ${rawUrl}`);
  process.exit(2);
}
const host = m[1];
const port = Number(m[2] ?? 3478);

const MAGIC = 0x2112a442;
const ALLOCATE = 0x0003;
const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  LIFETIME: 0x000d,
};

const pad4 = (n) => (n % 4 === 0 ? 0 : 4 - (n % 4));

function attr(type, value) {
  const b = Buffer.alloc(4 + value.length + pad4(value.length));
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(value.length, 2);
  value.copy(b, 4);
  return b;
}

function buildAllocate(txn, creds) {
  const parts = [
    // UDP transport, per RFC 5766 §14.7.
    attr(ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])),
    attr(ATTR.LIFETIME, Buffer.from([0, 0, 2, 88])),
  ];
  if (creds) {
    parts.push(
      attr(ATTR.USERNAME, Buffer.from(creds.username, "utf8")),
      attr(ATTR.REALM, Buffer.from(creds.realm, "utf8")),
      attr(ATTR.NONCE, creds.nonce),
    );
  }

  const body = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(ALLOCATE, 0);
  header.writeUInt32BE(MAGIC, 4);
  txn.copy(header, 8);

  if (!creds) {
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }

  // MESSAGE-INTEGRITY covers a length that already includes the attribute
  // itself (24 bytes), which is the part that is easy to get wrong.
  header.writeUInt16BE(body.length + 24, 2);
  const key = crypto
    .createHash("md5")
    .update(`${creds.username}:${creds.realm}:${creds.password}`)
    .digest();
  const hmac = crypto
    .createHmac("sha1", key)
    .update(Buffer.concat([header, body]))
    .digest();
  return Buffer.concat([header, body, attr(ATTR.MESSAGE_INTEGRITY, hmac)]);
}

function parse(msg) {
  const out = { type: msg.readUInt16BE(0), attrs: {} };
  let off = 20;
  const end = 20 + msg.readUInt16BE(2);
  while (off + 4 <= end && off + 4 <= msg.length) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    out.attrs[type] = msg.subarray(off + 4, off + 4 + len);
    off += 4 + len + pad4(len);
  }
  return out;
}

function xorAddress(buf) {
  const family = buf.readUInt8(1);
  const port = buf.readUInt16BE(2) ^ (MAGIC >>> 16);
  if (family === 0x01) {
    const raw = buf.readUInt32BE(4) ^ MAGIC;
    return `${[24, 16, 8, 0].map((s) => (raw >>> s) & 0xff).join(".")}:${port}`;
  }
  return `[ipv6]:${port}`;
}

const sock = dgram.createSocket("udp4");
const send = (buf) => sock.send(buf, port, host);

let stage = "probe";
const txn = crypto.randomBytes(12);

const timer = setTimeout(() => {
  console.log(`FAIL  ${host}:${port} — no response (UDP blocked or host down)`);
  sock.close();
  process.exit(1);
}, 8000);

sock.on("message", (msg) => {
  const res = parse(msg);
  const isError = (res.type & 0x0110) === 0x0110;

  if (stage === "probe" && isError) {
    const err = res.attrs[ATTR.ERROR_CODE];
    const code = err ? err.readUInt8(2) * 100 + err.readUInt8(3) : 0;

    if (code === 401 && username && password) {
      stage = "auth";
      send(
        buildAllocate(txn, {
          username,
          password,
          realm: res.attrs[ATTR.REALM].toString("utf8"),
          nonce: res.attrs[ATTR.NONCE],
        }),
      );
      return;
    }

    clearTimeout(timer);
    console.log(
      code === 401
        ? `REACHABLE  ${host}:${port} — server answered and wants credentials (none supplied)`
        : `FAIL  ${host}:${port} — TURN error ${code}`,
    );
    sock.close();
    process.exit(code === 401 ? 0 : 1);
  }

  clearTimeout(timer);
  const relayed = res.attrs[ATTR.XOR_RELAYED_ADDRESS];
  if (!isError && relayed) {
    console.log(`OK  ${host}:${port} — allocated relay ${xorAddress(relayed)}`);
    sock.close();
    process.exit(0);
  }

  const err = res.attrs[ATTR.ERROR_CODE];
  const code = err ? err.readUInt8(2) * 100 + err.readUInt8(3) : 0;
  console.log(`FAIL  ${host}:${port} — credentials rejected (TURN error ${code})`);
  sock.close();
  process.exit(1);
});

sock.on("error", (err) => {
  clearTimeout(timer);
  console.log(`FAIL  ${host}:${port} — ${err.message}`);
  process.exit(1);
});

send(buildAllocate(txn, null));
