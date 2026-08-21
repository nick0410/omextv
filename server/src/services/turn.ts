import crypto from "crypto";
import { env } from "../config/env";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServer[];
  /** When these credentials stop working, so the client can refresh in time. */
  expiresAt: number | null;
  /** True when a relay is configured at all. */
  hasTurn: boolean;
}

/**
 * Time-limited TURN credentials, per the coturn REST API convention
 * (`use-auth-secret` / `static-auth-secret`).
 *
 * username = "<unix-expiry>:<userId>"
 * credential = base64(HMAC-SHA1(username, sharedSecret))
 *
 * The alternative — shipping one fixed TURN username and password to every
 * browser — means anyone who opens devtools can point their own traffic at
 * your relay. Relay bandwidth is the expensive part of running TURN, so that
 * matters. These expire on their own and are scoped to a single user.
 */
export function makeTurnCredentials(
  userId: string,
  secret: string,
  ttlSeconds: number,
  now: number = Date.now(),
): { username: string; credential: string; expiresAt: number } {
  const expiryUnix = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiryUnix}:${userId}`;
  const credential = crypto
    .createHmac("sha1", secret)
    .update(username)
    .digest("base64");

  return { username, credential, expiresAt: expiryUnix * 1000 };
}

/**
 * Build the ICE server list for one user.
 *
 * STUN alone is enough for most people, but fails whenever both peers sit
 * behind symmetric NAT — commonly cited at 10-15% of connections, and much
 * worse on corporate and mobile-carrier networks. Those calls only connect
 * through a TURN relay.
 */
export function buildIceConfig(userId: string, now: number = Date.now()): IceConfig {
  const iceServers: IceServer[] = [];

  if (env.STUN_URLS.length > 0) {
    iceServers.push({ urls: env.STUN_URLS });
  }

  const turnUrls = [env.TURN_SERVER_URL, ...env.TURN_URLS].filter(Boolean);
  if (turnUrls.length === 0) {
    return { iceServers, expiresAt: null, hasTurn: false };
  }

  if (env.TURN_SECRET) {
    const { username, credential, expiresAt } = makeTurnCredentials(
      userId,
      env.TURN_SECRET,
      env.TURN_TTL_SECONDS,
      now,
    );
    iceServers.push({ urls: turnUrls, username, credential });
    return { iceServers, expiresAt, hasTurn: true };
  }

  // Long-lived credentials: supported because most hosted TURN providers only
  // offer these, but the ephemeral path above is preferred where possible.
  if (env.TURN_SERVER_USERNAME && env.TURN_SERVER_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: env.TURN_SERVER_USERNAME,
      credential: env.TURN_SERVER_CREDENTIAL,
    });
    return { iceServers, expiresAt: null, hasTurn: true };
  }

  // A TURN URL with no credentials would be silently ignored by the browser,
  // so leave it out and report honestly that there is no relay.
  return { iceServers, expiresAt: null, hasTurn: false };
}

/** Warn once at boot if the deployment cannot relay. */
export function warnIfNoTurn(): void {
  const { hasTurn } = buildIceConfig("boot-check");
  if (!hasTurn && env.IS_PROD) {
    console.warn(
      "  ⚠️  No TURN server configured. Calls between peers behind symmetric " +
        "NAT (~10-15% of users) will fail to connect. Set TURN_SERVER_URL " +
        "plus TURN_SECRET, or TURN_SERVER_USERNAME/TURN_SERVER_CREDENTIAL.",
    );
  }
}
