import crypto from "node:crypto";
import { ensureCoreSchema } from "@sm/db";

export type ApiCredentialRow = {
  id: string;
  tenantId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  createdAt: Date;
  createdBy: string | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export type ApiCredentialMetadata = {
  id: string;
  tenantId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CreateApiCredentialInput = {
  tenantId: string;
  name: string;
  scopes: string[];
  createdBy?: string | null;
};

type ApiCredentialStore = {
  create(input: CreateApiCredentialInput): Promise<ApiCredentialRow & { token: string }>;
  list(tenantId: string): Promise<ApiCredentialRow[]>;
  revoke(tenantId: string, id: string): Promise<boolean>;
  findByPlainToken(plaintext: string): Promise<ApiCredentialRow | null>;
  touchLastUsed(id: string): Promise<void>;
  resetForTests?(): void | Promise<void>;
};

const credentialsByTenant = new Map<string, ApiCredentialRow[]>();
let cachedStorePromise: Promise<ApiCredentialStore> | null = null;

function isExplicitInMemoryMode(): boolean {
  // Reuse the same env knob as enrollmentStore — if the operator runs in dev,
  // both stores share a backing strategy.
  return process.env.SM_ENROLLMENT_STORE?.trim().toLowerCase() === "memory";
}

function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function toApiCredentialMetadata(row: ApiCredentialRow): ApiCredentialMetadata {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null
  };
}

function createInMemoryStore(): ApiCredentialStore {
  return {
    async create(input) {
      const plaintext = `kop_${crypto.randomBytes(32).toString("hex")}`;
      const tokenHash = hashToken(plaintext);
      const row: ApiCredentialRow = {
        id: `apicred-${crypto.randomUUID()}`,
        tenantId: input.tenantId,
        name: input.name,
        tokenHash,
        scopes: [...input.scopes],
        createdAt: new Date(),
        createdBy: input.createdBy ?? null,
        lastUsedAt: null,
        revokedAt: null
      };
      const list = credentialsByTenant.get(input.tenantId) ?? [];
      list.push(row);
      credentialsByTenant.set(input.tenantId, list);
      return { ...row, token: plaintext };
    },
    async list(tenantId) {
      const list = credentialsByTenant.get(tenantId) ?? [];
      return [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async revoke(tenantId, id) {
      const list = credentialsByTenant.get(tenantId) ?? [];
      const row = list.find((r) => r.id === id && r.revokedAt === null);
      if (!row) return false;
      row.revokedAt = new Date();
      return true;
    },
    async findByPlainToken(plaintext) {
      const hash = hashToken(plaintext);
      for (const rows of credentialsByTenant.values()) {
        for (const row of rows) {
          if (row.tokenHash === hash && row.revokedAt === null) {
            return row;
          }
        }
      }
      return null;
    },
    async touchLastUsed(id) {
      for (const rows of credentialsByTenant.values()) {
        for (const row of rows) {
          if (row.id === id) {
            row.lastUsedAt = new Date();
            return;
          }
        }
      }
    },
    resetForTests() {
      credentialsByTenant.clear();
    }
  };
}

async function createPostgresStore(): Promise<ApiCredentialStore | null> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });
  await ensureCoreSchema(pool);

  function rowFrom(r: Record<string, unknown>): ApiCredentialRow {
    return {
      id: String(r.id),
      tenantId: String(r.tenant_id),
      name: String(r.name),
      tokenHash: String(r.token_hash),
      scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
      createdAt: new Date(String(r.created_at)),
      createdBy: r.created_by == null ? null : String(r.created_by),
      lastUsedAt: r.last_used_at == null ? null : new Date(String(r.last_used_at)),
      revokedAt: r.revoked_at == null ? null : new Date(String(r.revoked_at))
    };
  }

  return {
    async create(input) {
      const plaintext = `kop_${crypto.randomBytes(32).toString("hex")}`;
      const tokenHash = hashToken(plaintext);
      const id = `apicred-${crypto.randomUUID()}`;
      const result = await pool.query(
        `insert into api_credentials (id, tenant_id, name, token_hash, scopes, created_by)
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [id, input.tenantId, input.name, tokenHash, input.scopes, input.createdBy ?? null]
      );
      const row = rowFrom(result.rows[0] as Record<string, unknown>);
      return { ...row, token: plaintext };
    },
    async list(tenantId) {
      const result = await pool.query(
        `select * from api_credentials where tenant_id = $1 order by created_at desc`,
        [tenantId]
      );
      return result.rows.map((r) => rowFrom(r as Record<string, unknown>));
    },
    async revoke(tenantId, id) {
      const result = await pool.query(
        `update api_credentials set revoked_at = now()
          where id = $1 and tenant_id = $2 and revoked_at is null
        returning id`,
        [id, tenantId]
      );
      return (result.rowCount ?? 0) > 0;
    },
    async findByPlainToken(plaintext) {
      const result = await pool.query(
        `select * from api_credentials where token_hash = $1 and revoked_at is null limit 1`,
        [hashToken(plaintext)]
      );
      if (result.rows.length === 0) return null;
      return rowFrom(result.rows[0] as Record<string, unknown>);
    },
    async touchLastUsed(id) {
      await pool.query(`update api_credentials set last_used_at = now() where id = $1`, [id]);
    }
  };
}

async function getStore(): Promise<ApiCredentialStore> {
  if (!cachedStorePromise) {
    cachedStorePromise = (async () => {
      if (isExplicitInMemoryMode()) {
        return createInMemoryStore();
      }
      const pg = await createPostgresStore();
      if (pg) return pg;
      // Fallback to in-memory in dev when no DATABASE_URL set; lets tests run.
      return createInMemoryStore();
    })();
  }
  return cachedStorePromise;
}

export async function createApiCredentialForTenant(
  input: CreateApiCredentialInput
): Promise<{ metadata: ApiCredentialMetadata; token: string }> {
  const store = await getStore();
  const row = await store.create(input);
  return { metadata: toApiCredentialMetadata(row), token: row.token };
}

export async function listApiCredentialsForTenant(tenantId: string): Promise<ApiCredentialMetadata[]> {
  const store = await getStore();
  const rows = await store.list(tenantId);
  return rows.map(toApiCredentialMetadata);
}

export async function revokeApiCredentialForTenant(tenantId: string, id: string): Promise<boolean> {
  const store = await getStore();
  return store.revoke(tenantId, id);
}

export async function findApiCredentialByPlainToken(plaintext: string): Promise<ApiCredentialRow | null> {
  const store = await getStore();
  return store.findByPlainToken(plaintext);
}

export async function touchApiCredential(id: string): Promise<void> {
  const store = await getStore();
  await store.touchLastUsed(id);
}

export async function __resetApiCredentialStoreForTests(): Promise<void> {
  if (cachedStorePromise) {
    const store = await cachedStorePromise;
    if (store.resetForTests) {
      await store.resetForTests();
    }
  }
  cachedStorePromise = null;
}
