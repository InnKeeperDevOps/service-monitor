import { z } from "zod";

export const apiEnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().default("test-secret"),
  INTERNAL_API_URL: z.string().optional(),
  INTERNAL_API_TOKEN: z.string().default("dev-token"),
});

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DISABLED: z.enum(["0", "1"]).default("0"),
  WORKER_HEALTH_PORT: z.coerce.number().default(9090),
  WORKER_HEALTH_HOST: z.string().default("0.0.0.0"),
  GITHUB_APP_ID: z.coerce.number().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  SM_EXECUTOR_SIMULATE: z.enum(["0", "1"]).default("0"),
  SM_CURSOR_BIN: z.string().default("cursor"),
  SM_CLAUDE_BIN: z.string().default("claude"),
  SM_GITHUB_SIMULATE: z.enum(["0", "1"]).default("0"),
  INTERNAL_API_URL: z.string().optional(),
  INTERNAL_API_TOKEN: z.string().default("dev-token"),
});

export const agentEnvSchema = z.object({
  PLATFORM_URL: z.string(),
  ENROLLMENT_TOKEN: z.string().optional(),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function loadEnv<T>(schema: z.ZodType<T>, env: Record<string, string | undefined> = process.env): T {
  return schema.parse(env);
}
