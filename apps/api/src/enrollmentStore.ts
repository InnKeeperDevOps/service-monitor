import crypto from "node:crypto";
import type { EnrollmentTokenMetadata } from "@sm/contracts";
import { ensureCoreSchema } from "@sm/db";

export type EnrollmentTokenRow = {
  id: string;
  tenantId: string;
  tokenHash: string;
  expiresAt: Date;
  createdBy: string;
  createdAt: Date;
  usedAt: Date | null;
};

const tokensByTenant = new Map<string, EnrollmentTokenRow[]>();
type EnrollmentStore = {
  create(input: { tenantId: string; createdBy: string; ttlSeconds: number }): Promise<EnrollmentTokenRow & { token: string }>;
  list(tenantId: string): Promise<EnrollmentTokenRow[]>;
  delete(tenantId: string, tokenId: string): Promise<boolean>;
  consume(plaintext: string): Promise<{ tenantId: string; tokenId: string } | null>;
  resetForTests?(): void | Promise<void>;
};

let cachedStorePromise: Promise<EnrollmentStore> | null = null;

function isExplicitInMemoryMode(): boolean {
  return process.env.SM_ENROLLMENT_STORE?.trim().toLowerCase() === "memory";
}

function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

function toMetadata(row: EnrollmentTokenRow): EnrollmentTokenMetadata {
  const isActive = row.usedAt === null && row.expiresAt.getTime() > Date.now();
  return {
    id: row.id,
    tenantId: row.tenantId,
    expiresAt: row.expiresAt.toISOString(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    usedAt: row.usedAt ? row.usedAt.toISOString() : null,
    isActive
  };
}

function createInMemoryEnrollmentStore(): EnrollmentStore {
  return {
    async create(input) {
      const plaintext = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashToken(plaintext);
      const now = new Date();
      const id = crypto.randomUUID();
      const row: EnrollmentTokenRow = {
        id,
        tenantId: input.tenantId,
        tokenHash,
        expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
        createdBy: input.createdBy,
        createdAt: now,
        usedAt: null
      };
      const list = tokensByTenant.get(input.tenantId) ?? [];
      list.push(row);
      tokensByTenant.set(input.tenantId, list);
      return { ...row, token: plaintext };
    },
    async list(tenantId) {
      const list = tokensByTenant.get(tenantId) ?? [];
      return [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async delete(tenantId, tokenId) {
      const list = tokensByTenant.get(tenantId) ?? [];
      const before = list.length;
      const next = list.filter((row) => row.id !== tokenId);
      if (next.length === before) {
        return false;
      }
      if (next.length === 0) {
        tokensByTenant.delete(tenantId);
      } else {
        tokensByTenant.set(tenantId, next);
      }
      return true;
    },
    async consume(plaintext) {
      const hash = hashToken(plaintext);
      const now = new Date();
      for (const rows of tokensByTenant.values()) {
        for (const row of rows) {
          if (row.tokenHash === hash && row.usedAt === null && row.expiresAt > now) {
            row.usedAt = now;
            return { tenantId: row.tenantId, tokenId: row.id };
          }
        }
      }
      return null;
    },
    resetForTests() {
      tokensByTenant.clear();
    }
  };
}

async function createPostgresEnrollmentStore(): Promise<EnrollmentStore | null> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    await ensureCoreSchema(pool);
    return {
      async create(input) {
        const plaintext = crypto.randomBytes(32).toString("hex");
        const tokenHash = hashToken(plaintext);
        const now = new Date();
        const row: EnrollmentTokenRow = {
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          tokenHash,
          expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
          createdBy: input.createdBy,
          createdAt: now,
          usedAt: null
        };
        await pool.query(
          `insert into agent_enrollment_tokens (id, tenant_id, token_hash, expires_at, created_by, created_at, used_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [row.id, row.tenantId, row.tokenHash, row.expiresAt.toISOString(), row.createdBy, row.createdAt.toISOString(), null]
        );
        return { ...row, token: plaintext };
      },
      async list(tenantId) {
        const result = await pool.query(
          `select id, tenant_id, token_hash, expires_at, created_by, created_at, used_at
             from agent_enrollment_tokens
            where tenant_id = $1
            order by created_at desc`,
          [tenantId]
        );
        return result.rows.map((row) => ({
          id: String(row.id),
          tenantId: String(row.tenant_id),
          tokenHash: String(row.token_hash),
          expiresAt: new Date(String(row.expires_at)),
          createdBy: String(row.created_by),
          createdAt: new Date(String(row.created_at)),
          usedAt: row.used_at ? new Date(String(row.used_at)) : null
        }));
      },
      async delete(tenantId, tokenId) {
        const result = await pool.query(
          `delete from agent_enrollment_tokens
            where tenant_id = $1
              and id = $2`,
          [tenantId, tokenId]
        );
        return (result.rowCount ?? 0) > 0;
      },
      async consume(plaintext) {
        const result = await pool.query(
          `update agent_enrollment_tokens
              set used_at = now()
            where token_hash = $1
              and used_at is null
              and expires_at > now()
          returning tenant_id, id`,
          [hashToken(plaintext)]
        );
        if (result.rows.length === 0) return null;
        return {
          tenantId: String(result.rows[0].tenant_id),
          tokenId: String(result.rows[0].id)
        };
      }
    };
  } catch (err) {
    throw new Error(
      `DATABASE_URL is configured but enrollment token store could not initialize: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

async function getEnrollmentStore(): Promise<EnrollmentStore> {
  if (!cachedStorePromise) {
    cachedStorePromise = (async () => {
      // Explicit dev mode wins over DATABASE_URL so local tests / CI need not run Postgres.
      if (isExplicitInMemoryMode()) {
        return createInMemoryEnrollmentStore();
      }
      const pgStore = await createPostgresEnrollmentStore();
      if (pgStore) return pgStore;
      throw new Error(
        "Enrollment token store is not configured. Set DATABASE_URL for durable storage, or set SM_ENROLLMENT_STORE=memory for explicit dev mode."
      );
    })();
  }
  return cachedStorePromise;
}

export async function createEnrollmentTokenForTenant(input: {
  tenantId: string;
  createdBy: string;
  ttlSeconds: number;
}): Promise<{ token: string; response: EnrollmentTokenMetadata & { token: string } }> {
  const store = await getEnrollmentStore();
  const row = await store.create(input);
  const metadata = toMetadata(row);
  return { token: row.token, response: { ...metadata, token: row.token } };
}

export async function listEnrollmentTokensForTenant(tenantId: string): Promise<EnrollmentTokenMetadata[]> {
  const store = await getEnrollmentStore();
  const rows = await store.list(tenantId);
  return rows.map(toMetadata);
}

export async function deleteEnrollmentTokenForTenant(tenantId: string, tokenId: string): Promise<boolean> {
  const store = await getEnrollmentStore();
  return store.delete(tenantId, tokenId);
}

export async function validateEnrollmentToken(plaintext: string): Promise<{ tenantId: string; tokenId: string } | null> {
  const store = await getEnrollmentStore();
  return store.consume(plaintext);
}

/** Test helper: clear in-memory enrollment state */
export async function __resetEnrollmentStoreForTests(): Promise<void> {
  const maybeStore = await cachedStorePromise?.catch(() => null);
  if (maybeStore?.resetForTests) {
    await maybeStore.resetForTests();
  }
  tokensByTenant.clear();
  cachedStorePromise = null;
}
