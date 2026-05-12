// Manual GC entry point. Wired as `pnpm --filter @sm/api registry:gc`.
//
// Connects to DATABASE_URL, runs one GC pass, prints a summary, exits.
// Intended for one-shot operator use ("reclaim space now") and as the
// thing a future cron job would call. No daemon mode, no scheduling.

import { Pool } from "pg";
import { ensureCoreSchema, type QueryFn } from "@sm/db";
import { runGarbageCollection } from "./gc.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url?.trim()) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });
  try {
    await ensureCoreSchema(pool);
    const queryFn: QueryFn = async (sql, params) => {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows as Record<string, unknown>[] };
    };
    const stats = await runGarbageCollection(pool, queryFn, {
      log: (line) => console.log(line)
    });
    console.log("");
    console.log(`expiredUploadsReclaimed: ${stats.expiredUploadsReclaimed}`);
    console.log(`orphanManifestsReclaimed: ${stats.orphanManifestsReclaimed}`);
    console.log(`orphanBlobsReclaimed: ${stats.orphanBlobsReclaimed}`);
    console.log(`bytesReclaimed: ${stats.bytesReclaimed}`);
    if (stats.errors.length > 0) {
      console.log("");
      console.log(`errors: ${stats.errors.length}`);
      for (const e of stats.errors) console.log(`  - ${e}`);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
