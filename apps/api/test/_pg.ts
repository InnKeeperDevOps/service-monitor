// Real-Postgres integration harness. Opt-in via TEST_DATABASE_URL so
// devs without a DB still run the rest of the suite; CI provides a
// postgres service container (see .github/workflows/ci.yml).
import { Pool } from "pg";
import { ensureCoreSchema, __resetEnsureCoreSchemaForTests } from "@sm/db";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL?.trim() || "";
export const hasTestDb = TEST_DB_URL.length > 0;

/** Open a pool against the test DB and ensure the core schema exists. */
export async function openTestPool(): Promise<Pool> {
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 4 });
  __resetEnsureCoreSchemaForTests();
  await ensureCoreSchema(pool);
  return pool;
}

/** Truncate every app table so each suite starts clean (FK-safe). */
export async function resetDb(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await pool.query(`truncate ${list} restart identity cascade`);
}

/** DEV_SESSION (the dev-token bearer) resolves to this tenant. */
export const DEV_TENANT = "t-1";

export async function seedDevTenant(pool: Pool): Promise<void> {
  await pool.query(
    `insert into tenants (id, name) values ($1, 'Test Tenant')
     on conflict (id) do nothing`,
    [DEV_TENANT]
  );
}
