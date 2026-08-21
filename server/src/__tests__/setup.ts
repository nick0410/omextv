/**
 * Point every test at an isolated Postgres schema and Redis database.
 *
 * This runs before the test module — and therefore before `config/database`
 * instantiates PrismaClient — so the overrides actually take effect.
 *
 * Isolation strategy:
 *  - Postgres: a dedicated `omextv_test` schema in the same database. Prisma
 *    honours the `?schema=` parameter, so tests can never touch real rows even
 *    though they share a server.
 *  - Redis: logical database 15, which the suite is free to flush.
 */
const PG_TEST_SCHEMA = "omextv_test";

function withSchema(url: string, schema: string): string {
  const [base, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  params.set("schema", schema);
  return `${base}?${params.toString()}`;
}

function withRedisDb(url: string, db: number): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = `/${db}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

const baseUrl =
  process.env.DATABASE_URL ??
  "postgresql://omextv:omextv@localhost:5432/omextv?schema=public";

if (!baseUrl.startsWith("postgres")) {
  throw new Error(
    `Tests expect a Postgres DATABASE_URL, got "${baseUrl}". ` +
      `Start one with: docker compose up -d postgres`,
  );
}

process.env.DATABASE_URL = withSchema(baseUrl, PG_TEST_SCHEMA);

// Most suites exercise the in-memory store; the Redis suite opts in explicitly
// via REDIS_TEST_URL so a missing Redis does not fail everything else.
process.env.REDIS_TEST_URL = withRedisDb(
  process.env.REDIS_URL || "redis://localhost:6379",
  15,
);
delete process.env.REDIS_URL;

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-that-is-definitely-long-enough-32";
process.env.MATCH_SWEEP_INTERVAL_MS = "50";
process.env.RECONNECT_GRACE_MS = "300";
process.env.GENDER_PROVIDER = "mock";
