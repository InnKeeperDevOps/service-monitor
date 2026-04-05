import { coreSchemaSql } from "./schema.js";

/** Single-flight: core DDL runs once per process (safe across multiple pools hitting the same DB). */
let schemaReady: Promise<void> | null = null;

/**
 * Applies `coreSchemaSql` (idempotent CREATE TABLE / ALTER … IF NOT EXISTS) on first use.
 * Set `SM_SKIP_DB_SCHEMA_SYNC=1` to disable (e.g. strict no-DDL environments).
 */
export function ensureCoreSchema(pool: { query: (text: string) => Promise<unknown> }): Promise<void> {
  if (process.env.SM_SKIP_DB_SCHEMA_SYNC === "1") {
    return Promise.resolve();
  }
  schemaReady ??= pool.query(coreSchemaSql).then(() => undefined);
  return schemaReady;
}

/** Test helper: allow a fresh process or repeated test DB setup */
export function __resetEnsureCoreSchemaForTests(): void {
  schemaReady = null;
}
