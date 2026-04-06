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

    async findMembershipsWithTenants(userId) {
      const { rows } = await pool.query(
        `SELECT tm.tenant_id, tm.role, t.name AS tenant_name
         FROM tenant_memberships tm
         JOIN tenants t ON t.id = tm.tenant_id
         WHERE tm.user_id = $1
         ORDER BY t.name`,
        [userId]
      );
      return rows.map((r: { tenant_id: string; role: string; tenant_name: string }) => ({
        tenantId: r.tenant_id,
        role: r.role,
        tenantName: r.tenant_name,
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

    async updateSessionTenant(sessionId, tenantId) {
      const { rowCount } = await pool.query("UPDATE sessions SET tenant_id = $1 WHERE id = $2", [
        tenantId,
        sessionId,
      ]);
      return (rowCount ?? 0) > 0;
    },

    async findUserById(id) {
      const { rows } = await pool.query(
        "SELECT id, email FROM users WHERE id = $1",
        [id]
      );
      if (rows.length === 0) return null;
      return { id: rows[0].id, email: rows[0].email };
    },

    async createTenantAsUser({ userId, sessionId, name, tenantId: explicitId }) {
      const id = explicitId ?? `t-${crypto.randomUUID()}`;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const dup = await client.query("SELECT 1 FROM tenants WHERE id = $1", [id]);
        if (dup.rows.length > 0) {
          await client.query("ROLLBACK");
          throw Object.assign(new Error("Tenant id already exists"), { code: "TENANT_ID_TAKEN" });
        }
        await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [id, name]);
        await client.query(
          "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
          [id, userId]
        );
        const upd = await client.query(
          "UPDATE sessions SET tenant_id = $1 WHERE id = $2 AND user_id = $3",
          [id, sessionId, userId]
        );
        if ((upd.rowCount ?? 0) === 0) {
          await client.query("ROLLBACK");
          throw new Error("SESSION_UPDATE_FAILED");
        }
        await client.query("COMMIT");
        return { tenantId: id };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async deleteTenantForUser({ userId, tenantId }) {
      const protectedIds = new Set(
        [process.env.DEFAULT_WEBHOOK_TENANT_ID, process.env.SM_DEFAULT_TENANT_ID].filter(Boolean) as string[]
      );
      if (protectedIds.has(tenantId)) {
        return "protected";
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const auth = await client.query(
          "SELECT role FROM tenant_memberships WHERE user_id = $1 AND tenant_id = $2",
          [userId, tenantId]
        );
        if (auth.rows.length === 0) {
          await client.query("ROLLBACK");
          return "forbidden";
        }
        const role = auth.rows[0].role as string;
        if (role !== "owner" && role !== "admin") {
          await client.query("ROLLBACK");
          return "forbidden";
        }

        const exists = await client.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId]);
        if (exists.rows.length === 0) {
          await client.query("ROLLBACK");
          return "not_found";
        }

        await client.query(
          `UPDATE sessions s
           SET tenant_id = (
             SELECT tm.tenant_id
             FROM tenant_memberships tm
             JOIN tenants t ON t.id = tm.tenant_id
             WHERE tm.user_id = s.user_id AND tm.tenant_id <> $1
             ORDER BY t.name ASC
             LIMIT 1
           )
           WHERE s.tenant_id = $1
           AND EXISTS (
             SELECT 1 FROM tenant_memberships tm
             WHERE tm.user_id = s.user_id AND tm.tenant_id <> $1
           )`,
          [tenantId]
        );

        await client.query("DELETE FROM sessions WHERE tenant_id = $1", [tenantId]);

        const del = await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
        if ((del.rowCount ?? 0) === 0) {
          await client.query("ROLLBACK");
          return "not_found";
        }
        await client.query("COMMIT");
        return "deleted";
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
