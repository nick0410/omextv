import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { makeTurnCredentials } from "../services/turn";

const NOW = 1_700_000_000_000;
const SECRET = "shared-turn-secret";

describe("makeTurnCredentials", () => {
  it("builds a username of <expiry>:<userId>", () => {
    const { username } = makeTurnCredentials("user-42", SECRET, 3600, NOW);
    const [expiry, userId] = username.split(":");
    expect(userId).toBe("user-42");
    expect(Number(expiry)).toBe(Math.floor(NOW / 1000) + 3600);
  });

  it("signs the username with HMAC-SHA1 as coturn expects", () => {
    const { username, credential } = makeTurnCredentials("user-42", SECRET, 3600, NOW);
    const expected = crypto.createHmac("sha1", SECRET).update(username).digest("base64");
    expect(credential).toBe(expected);
  });

  it("reports the expiry in milliseconds so a client can refresh in time", () => {
    const { expiresAt } = makeTurnCredentials("u", SECRET, 600, NOW);
    expect(expiresAt).toBe(NOW + 600_000);
  });

  it("issues different credentials to different users", () => {
    const a = makeTurnCredentials("alice", SECRET, 3600, NOW);
    const b = makeTurnCredentials("bob", SECRET, 3600, NOW);
    expect(a.credential).not.toBe(b.credential);
  });

  it("rotates the credential as time advances", () => {
    const first = makeTurnCredentials("u", SECRET, 3600, NOW);
    const later = makeTurnCredentials("u", SECRET, 3600, NOW + 5_000);
    expect(first.credential).not.toBe(later.credential);
  });

  it("changes completely when the shared secret changes", () => {
    const a = makeTurnCredentials("u", SECRET, 3600, NOW);
    const b = makeTurnCredentials("u", "different-secret", 3600, NOW);
    expect(a.username).toBe(b.username);
    expect(a.credential).not.toBe(b.credential);
  });

  it("produces a credential a TURN server can verify from the username alone", () => {
    // This is the whole point of the scheme: the server stores no per-user
    // state, it just recomputes the HMAC from the username it was handed.
    const { username, credential } = makeTurnCredentials("user-9", SECRET, 120, NOW);
    const serverSide = crypto
      .createHmac("sha1", SECRET)
      .update(username)
      .digest("base64");
    expect(serverSide).toBe(credential);

    const expiry = Number(username.split(":")[0]) * 1000;
    expect(expiry).toBeGreaterThan(NOW);
  });
});
