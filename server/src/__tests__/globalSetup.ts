import { execFileSync } from "child_process";

/**
 * Create the test schema once per run.
 *
 * `prisma db push` is idempotent, so re-running is cheap, but it has to happen
 * before any test connects — hence globalSetup rather than a per-file hook.
 */
export async function setup(): Promise<void> {
  const base =
    process.env.DATABASE_URL ??
    "postgresql://omextv:omextv@localhost:5432/omextv?schema=public";

  const [root, query = ""] = base.split("?");
  const params = new URLSearchParams(query);
  params.set("schema", "omextv_test");
  const testUrl = `${root}?${params.toString()}`;

  try {
    execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
      shell: process.platform === "win32",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not prepare the test schema. Is Postgres running?\n` +
        `  docker compose up -d postgres\n\n${detail}`,
    );
  }
}
