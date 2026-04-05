import crypto from "node:crypto";
import type { Pool } from "pg";
import type { AuthStore } from "./auth.js";

export function createPostgresAuthStore(pool: Pool): AuthStore {
  return {
    async findUserByEmail(email) {
      const { rows } = await pool.query(
        "SELECT id, email, password_hash FROM users WHERE email = $1",
        [email]
      );
      if (rows.length === 0) return null;
      return {
        id: rows[0].id,
        email: rows[0].email,
        passwordHash: rows[0].password_hash,
      };
    },

    async findMemberships(userId) {
      const { rows } = await pool.query(
        "SELECT tenant_id, role FROM tenant_memberships WHERE user_id = $1",
        [userId]
      );
      return rows.map((r: { tenant_id: string; role: string }) => ({
        tenantId: r.tenant_id,
        role: r.role,
      }));
    },

    async createSession(userId, tenantId, tokenHash, expiresAt) {
      const id = `sess-${crypto.randomUUID()}`;
      await pool.query(
        "INSERT INTO sessions (id, user_id, tenant_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)",
        [id, userId, tenantId, tokenHash, expiresAt]
      );
      return id;
    },

    async findSessionByTokenHash(tokenHash) {
      const { rows } = await pool.query(
        "SELECT id, user_id, tenant_id, expires_at FROM sessions WHERE token_hash = $1",
        [tokenHash]
      );
      if (rows.length === 0) return null;
      return {
        id: rows[0].id,
        userId: rows[0].user_id,
        tenantId: rows[0].tenant_id,
        expiresAt: new Date(rows[0].expires_at),
      };
    },

    async findUserById(id) {
      const { rows } = await pool.query(
        "SELECT id, email FROM users WHERE id = $1",
        [id]
      );
      if (rows.length === 0) return null;
      return { id: rows[0].id, email: rows[0].email };
    },
  };
}
