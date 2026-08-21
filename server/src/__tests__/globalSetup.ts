import { execFileSync } from "child_process";
import { probeTcp, parseHostPort } from "./dbAvailable";

/**
 * Prepare the test schema, and decide which suites can run.
 *
 * Most of this suite is pure logic — matchmaking, inference, rate limiting —
 * and needs no infrastructure. Failing the whole run because Docker is down
 * would mean nobody can check that logic without standing up a database
 * first, so the suites that genuinely need one skip themselves instead.
 *
 * This runs in the main process before any worker is forked, so the flags set
 * here are inherited by every test file.
 */
export async function setup(): Promise<void> {
  const base =
    process.env.DATABASE_URL ??
    "postgresql://omextv:omextv@localhost:5432/omextv?schema=public";

  const [root, query = ""] = base.split("?");
  const params = new URLSearchParams(query);
  params.set("schema", "omextv_test");
  const testUrl = `${root}?${params.toString()}`;

  const [pgHost, pgPort] = parseHostPort(base, 5432);
  const [redisHost, redisPort] = parseHostPort(
    process.env.REDIS_URL || "redis://localhost:6379",
    6379,
  );

  const [pgUp, redisUp] = await Promise.all([
    probeTcp(pgHost, pgPort),
    probeTcp(redisHost, redisPort),
  ]);

  process.env.OMEXTV_REDIS_READY = redisUp ? "1" : "0";

  if (!pgUp) {
    process.env.OMEXTV_DB_READY = "0";
    warn("Postgres", redisUp);
    return;
  }

  try {
    execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    process.env.OMEXTV_DB_READY = "1";
  } catch {
    // Reachable but the schema could not be applied — same outcome for the
    // suites that need it, and still not a reason to fail the rest.
    process.env.OMEXTV_DB_READY = "0";
    warn("The test schema", redisUp);
    return;
  }

  if (!redisUp) warn("Redis", true);
}

function warn(what: string, redisUp: boolean): void {
  const also = redisUp ? "" : " Redis is also unreachable.";
  console.warn(
    `\n  ${what} is not available — the suites that need it will be skipped.${also}` +
      `\n  Start the services with: docker compose up -d postgres redis\n`,
  );
}
