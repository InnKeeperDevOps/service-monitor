import type { FastifyInstance } from "fastify";
import { createRedisConnectionFromEnv } from "@sm/queue";

export type SetupStatus = {
  setupRequired: boolean;
  setupComplete: boolean;
  version: string;
};

export type RegisterSetupRoutesOptions = {
  getStatus: () => SetupStatus;
};

export function registerSetupRoutes(app: FastifyInstance, opts: RegisterSetupRoutesOptions): void {
  app.get("/api/v1/setup/status", async () => {
    return opts.getStatus();
  });

  app.post("/api/v1/setup/test-database", async (req, reply) => {
    const { databaseUrl } = (req.body ?? {}) as { databaseUrl?: string };
    if (!databaseUrl?.trim()) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "databaseUrl is required" });
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query("select 1");
      return { ok: true as const };
    } finally {
      await pool.end().catch(() => {});
    }
  });

  app.post("/api/v1/setup/test-redis", async (req, reply) => {
    const { redisUrl } = (req.body ?? {}) as { redisUrl?: string };
    if (!redisUrl?.trim()) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "redisUrl is required" });
    }
    const redis = createRedisConnectionFromEnv({ ...process.env, REDIS_URL: redisUrl });
    try {
      await redis.ping();
      return { ok: true as const };
    } finally {
      await redis.quit().catch(() => {});
    }
  });
}
