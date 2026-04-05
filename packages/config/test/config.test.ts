import { describe, expect, it } from "vitest";
import { loadEnv, apiEnvSchema, workerEnvSchema, agentEnvSchema } from "../src/index.js";

describe("loadEnv", () => {
  it("applies defaults when env is empty", () => {
    const env = loadEnv(apiEnvSchema, {});
    expect(env.PORT).toBe(3001);
    expect(env.NODE_ENV).toBe("development");
    expect(env.REDIS_HOST).toBe("127.0.0.1");
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.GITHUB_WEBHOOK_SECRET).toBe("test-secret");
    expect(env.INTERNAL_API_TOKEN).toBe("dev-token");
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("accepts overrides", () => {
    const env = loadEnv(apiEnvSchema, {
      PORT: "8080",
      NODE_ENV: "production",
      REDIS_HOST: "redis.local",
      REDIS_PORT: "6380",
      DATABASE_URL: "postgres://localhost/test",
    });
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe("production");
    expect(env.REDIS_HOST).toBe("redis.local");
    expect(env.REDIS_PORT).toBe(6380);
    expect(env.DATABASE_URL).toBe("postgres://localhost/test");
  });

  it("rejects missing required fields in agentEnvSchema", () => {
    expect(() => loadEnv(agentEnvSchema, {})).toThrow();
  });

  it("passes agentEnvSchema with required fields", () => {
    const env = loadEnv(agentEnvSchema, { PLATFORM_URL: "https://example.com" });
    expect(env.PLATFORM_URL).toBe("https://example.com");
    expect(env.DOCKER_SOCKET).toBe("/var/run/docker.sock");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("applies worker defaults", () => {
    const env = loadEnv(workerEnvSchema, {});
    expect(env.REDIS_DISABLED).toBe("0");
    expect(env.WORKER_HEALTH_PORT).toBe(9090);
    expect(env.WORKER_HEALTH_HOST).toBe("0.0.0.0");
    expect(env.SM_EXECUTOR_SIMULATE).toBe("0");
    expect(env.SM_CURSOR_BIN).toBe("cursor");
    expect(env.SM_CLAUDE_BIN).toBe("claude");
  });
});
