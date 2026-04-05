import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { isSetupRequired } from "./bootstrapEnv.js";
import { writeConfig, type KaiadConfig } from "./configPersistence.js";
import { hashPassword } from "./auth.js";
import { ensureCoreSchema } from "@sm/db";

export type SetupCompleteCallback = (config: KaiadConfig) => Promise<void>;

export async function setupRoutes(
  app: FastifyInstance,
  opts: { onSetupComplete?: SetupCompleteCallback },
): Promise<void> {
  app.get("/api/v1/setup/status", async () => {
    return {
      setupRequired: isSetupRequired(),
      version: process.env.npm_package_version ?? "0.1.0",
    };
  });

  app.post("/api/v1/setup/test-database", async (req, reply) => {
    const { databaseUrl } = req.body as { databaseUrl?: string };
    if (!databaseUrl?.trim()) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "databaseUrl is required" });
    }
    let pool: any;
    try {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
      await pool.query("SELECT 1");
      return { ok: true };
    } catch (err) {
      return reply.status(422).send({
        code: "DATABASE_UNREACHABLE",
        message: err instanceof Error ? err.message : "Database connection failed",
      });
    } finally {
      if (pool) await pool.end().catch(() => {});
    }
  });

  app.post("/api/v1/setup/test-redis", async (req, reply) => {
    const { redisUrl } = req.body as { redisUrl?: string };
    if (!redisUrl?.trim()) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "redisUrl is required" });
    }
    try {
      const url = new URL(redisUrl);
      const host = url.hostname || "127.0.0.1";
      const port = Number(url.port) || 6379;
      const net = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`TCP connect to ${host}:${port} timed out`));
        }, 5000);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.end();
          resolve();
        });
        socket.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return { ok: true };
    } catch (err) {
      return reply.status(422).send({
        code: "REDIS_UNREACHABLE",
        message: err instanceof Error ? err.message : "Redis connection failed",
      });
    }
  });

  app.get("/api/v1/setup/tenants", async (req, reply) => {
    const dbUrl = (req.query as Record<string, string>).databaseUrl ?? process.env.DATABASE_URL;
    if (!dbUrl?.trim()) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Database not configured yet" });
    }
    let pool: any;
    try {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
      const result = await pool.query("SELECT id, name FROM tenants ORDER BY name");
      return { tenants: result.rows };
    } catch (err) {
      return reply.status(500).send({
        code: "TENANT_LIST_FAILED",
        message: err instanceof Error ? err.message : "Failed to list tenants",
      });
    } finally {
      if (pool) await pool.end().catch(() => {});
    }
  });

  app.post("/api/v1/setup/complete", async (req, reply) => {
    if (!isSetupRequired()) {
      return reply.status(409).send({ code: "ALREADY_COMPLETE", message: "Setup has already been completed" });
    }

    const body = req.body as Record<string, unknown>;
    const databaseUrl = String(body.databaseUrl ?? "");
    const redisUrl = String(body.redisUrl ?? "");
    const publicBaseUrl = String(body.publicBaseUrl ?? "");
    const adminEmail = String(body.adminEmail ?? "");
    const adminPassword = String(body.adminPassword ?? "");
    const githubAppId = String(body.githubAppId ?? "");
    const githubAppPrivateKeyPem = String(body.githubAppPrivateKeyPem ?? "");
    const githubWebhookSecret = String(body.githubWebhookSecret ?? "");
    const googleClientId = String(body.googleClientId ?? "");
    const googleClientSecret = String(body.googleClientSecret ?? "");
    const defaultWebhookTenantId = body.defaultWebhookTenantId ? String(body.defaultWebhookTenantId) : undefined;
    const kubernetesNamespace = body.kubernetesNamespace ? String(body.kubernetesNamespace) : undefined;

    if (!databaseUrl.trim()) return reply.status(400).send({ code: "BAD_REQUEST", message: "databaseUrl is required" });
    if (!redisUrl.trim()) return reply.status(400).send({ code: "BAD_REQUEST", message: "redisUrl is required" });
    if (!adminEmail.trim()) return reply.status(400).send({ code: "BAD_REQUEST", message: "adminEmail is required" });
    if (!adminPassword || adminPassword.length < 8) return reply.status(400).send({ code: "BAD_REQUEST", message: "adminPassword must be at least 8 characters" });

    let pool: any;
    try {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString: databaseUrl });
      await ensureCoreSchema(pool);
    } catch (err) {
      if (pool) await pool.end().catch(() => {});
      return reply.status(422).send({
        code: "DATABASE_SETUP_FAILED",
        message: err instanceof Error ? err.message : "Database setup failed",
      });
    }

    const tenantId = "t-default";
    const userId = `u-${crypto.randomUUID()}`;
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
          [tenantId, "default"],
        );

        const passwordHash = await hashPassword(adminPassword);
        await client.query(
          `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
          [userId, adminEmail, passwordHash],
        );

        const userResult = await client.query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
        const actualUserId = userResult.rows[0]?.id ?? userId;

        await client.query(
          `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [tenantId, actualUserId, "owner"],
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      await pool.end().catch(() => {});
      return reply.status(500).send({
        code: "ADMIN_SEED_FAILED",
        message: err instanceof Error ? err.message : "Failed to create admin user",
      });
    }

    await pool.end().catch(() => {});

    const internalApiToken = String(body.internalApiToken ?? "") || crypto.randomBytes(32).toString("hex");

    const config: KaiadConfig = {
      setupComplete: true,
      databaseUrl,
      redisUrl,
      publicBaseUrl: publicBaseUrl || undefined,
      internalApiToken,
      internalApiUrl: `http://127.0.0.1:${process.env.PORT ?? "3001"}`,
      defaultWebhookTenantId: defaultWebhookTenantId ?? tenantId,
    };
    if (githubAppId) {
      config.githubApp = {
        appId: githubAppId,
        privateKeyPem: githubAppPrivateKeyPem,
        webhookSecret: githubWebhookSecret,
      };
    }
    if (googleClientId) {
      config.oauth = {
        googleClientId,
        googleClientSecret,
      };
    }
    if (kubernetesNamespace) {
      config.kubernetes = { namespace: kubernetesNamespace };
    }

    try {
      await writeConfig(config);
    } catch (err) {
      return reply.status(500).send({
        code: "CONFIG_WRITE_FAILED",
        message: err instanceof Error ? err.message : "Failed to write config",
      });
    }

    if (opts.onSetupComplete) {
      try {
        await opts.onSetupComplete(config);
      } catch (err) {
        console.error("[setup] Hot-reload after setup failed:", err);
      }
    }

    return { ok: true, tenantId, adminEmail };
  });
}
