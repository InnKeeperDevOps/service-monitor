import type { TenantSettings } from "@sm/contracts";
import type { Pool } from "pg";
import type { TenantStore } from "./memoryTenantStore.js";

const ENSURE_SQL = `
create table if not exists api_tenant_settings (
  tenant_id text primary key,
  payload jsonb not null
);
`;

export function createPostgresTenantStore(pool: Pool): TenantStore {
  let ensured = false;

  async function ensure(): Promise<void> {
    if (ensured) return;
    const client = await pool.connect();
    try {
      await client.query(ENSURE_SQL);
      ensured = true;
    } finally {
      client.release();
    }
  }

  return {
    async getTenantSettings(tenantId: string) {
      await ensure();
      const res = await pool.query<{ payload: TenantSettings }>(
        "select payload from api_tenant_settings where tenant_id = $1",
        [tenantId]
      );
      const row = res.rows[0];
      return row?.payload;
    },

    async upsertTenantSettings(settings: TenantSettings) {
      await ensure();
      await pool.query(
        `insert into api_tenant_settings (tenant_id, payload)
         values ($1, $2::jsonb)
         on conflict (tenant_id) do update set payload = excluded.payload`,
        [settings.tenantId, JSON.stringify(settings)]
      );
      return settings;
    }
  };
}
