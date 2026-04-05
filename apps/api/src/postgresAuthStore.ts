import crypto from "node:crypto";
import type { Pool } from "pg";
import type { AuthStore } from "./auth.js";

export function createPostgresAuthStore(pool: Pool): AuthStore {
  return {
    async findUserByEmail(email) {
      const result = await pool.query(
        `select id, email, password_hash from users where lower(email) = lower($1) limit 1`,
        [email]
      );
      if (result.rowCount === 0) {
        return null;
      }
      const row = result.rows[0] as { id: string; email: string; password_hash: string | null };
      return { id: row.id, email: row.email, passwordHash: row.password_hash };
    },
    async findMemberships(userId) {
      const result = await pool.query(
        `select tenant_id, role from tenant_memberships where user_id = $1 order by role asc`,
        [userId]
      );
      return result.rows.map((row) => ({
        tenantId: String((row as { tenant_id: string }).tenant_id),
        role: String((row as { role: string }).role)
      }));
    },
    async createSession(userId, tenantId, tokenHash, expiresAt) {
      const id = `sess-${crypto.randomUUID()}`;
      await pool.query(
        `insert into sessions (id, user_id, tenant_id, token_hash, expires_at) values ($1, $2, $3, $4, $5)`,
        [id, userId, tenantId, tokenHash, expiresAt]
      );
      return id;
    },
    async findSessionByTokenHash(tokenHash) {
      const result = await pool.query(
        `select id, user_id, tenant_id, expires_at from sessions where token_hash = $1 limit 1`,
        [tokenHash]
      );
      if (result.rowCount === 0) {
        return null;
      }
      const row = result.rows[0] as {
        id: string;
        user_id: string;
        tenant_id: string;
        expires_at: Date | string;
      };
      return {
        id: row.id,
        userId: row.user_id,
        tenantId: row.tenant_id,
        expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
      };
    },
    async findUserById(id) {
      const result = await pool.query(`select id, email from users where id = $1 limit 1`, [id]);
      if (result.rowCount === 0) {
        return null;
      }
      const row = result.rows[0] as { id: string; email: string };
      return { id: row.id, email: row.email };
    }
  };
}
