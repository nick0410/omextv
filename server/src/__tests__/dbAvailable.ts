import net from "net";

/**
 * Is Postgres reachable?
 *
 * Most of this suite is pure logic and needs no database at all. Letting the
 * whole run die because Docker is not up means a contributor cannot check the
 * matchmaking or inference code without standing up infrastructure first — so
 * the database-backed suites skip themselves instead, loudly.
 */
export function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

export function parseHostPort(url: string, fallbackPort: number): [string, number] {
  try {
    const parsed = new URL(url);
    return [parsed.hostname || "localhost", Number(parsed.port) || fallbackPort];
  } catch {
    return ["localhost", fallbackPort];
  }
}

/** Set by setup.ts before any test module loads. */
export function isDbReady(): boolean {
  return process.env.OMEXTV_DB_READY === "1";
}

export function isRedisReady(): boolean {
  return process.env.OMEXTV_REDIS_READY === "1";
}
