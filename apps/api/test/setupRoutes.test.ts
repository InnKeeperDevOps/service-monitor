import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { setupRoutes } from "../src/setupRoutes.js";

vi.mock("../src/bootstrapEnv.js", () => ({
  isSetupRequired: vi.fn(() => true),
}));

vi.mock("pg", () => ({
  Pool: class {
    query = vi.fn().mockResolvedValue({ rows: [{ id: "t-1", name: "test-tenant" }] });
    end = vi.fn().mockResolvedValue(undefined);
    connect = vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ id: "u-1" }] }),
      release: vi.fn(),
    });
  }
}));

vi.mock("node:net", () => ({
  createConnection: vi.fn().mockReturnValue({
    once: vi.fn((event, cb) => {
      if (event === "connect") {
        setTimeout(cb, 10);
      }
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("../src/configPersistence.js", () => ({
  writeConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/auth.js", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed"),
}));

vi.mock("@sm/db", () => ({
  ensureCoreSchema: vi.fn().mockResolvedValue(undefined),
}));

describe("setupRoutes", () => {
  it("GET /api/v1/setup/status returns status", async () => {
    const app = Fastify();
    await setupRoutes(app, {});

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/setup/status",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      setupRequired: true,
      version: expect.any(String),
    });
  });

  it("POST /api/v1/setup/test-database success", async () => {
    const app = Fastify();
    await setupRoutes(app, {});

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/test-database",
      payload: { databaseUrl: "postgres://user:pass@localhost:5432/db" },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ ok: true });
  });

  it("POST /api/v1/setup/test-redis success", async () => {
    const app = Fastify();
    await setupRoutes(app, {});

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/test-redis",
      payload: { redisUrl: "redis://localhost:6379" },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ ok: true });
  });

  it("GET /api/v1/setup/tenants success", async () => {
    const app = Fastify();
    await setupRoutes(app, {});

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/setup/tenants?databaseUrl=postgres://user:pass@localhost:5432/db",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      tenants: [{ id: "t-1", name: "test-tenant" }],
    });
  });

  it("POST /api/v1/setup/complete success", async () => {
    const app = Fastify();
    let setupCompleteCalled = false;
    await setupRoutes(app, {
      onSetupComplete: async () => {
        setupCompleteCalled = true;
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        databaseUrl: "postgres://",
        redisUrl: "redis://",
        adminEmail: "admin@example.com",
        adminPassword: "password123",
        githubAppId: "123",
        githubAppPrivateKeyPem: "pem",
        githubWebhookSecret: "sec",
        googleClientId: "client",
        googleClientSecret: "secret",
        kubernetesNamespace: "kaiad"
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      ok: true,
      tenantId: "t-default",
      adminEmail: "admin@example.com"
    });
    expect(setupCompleteCalled).toBe(true);
  });

  it("POST /api/v1/setup/complete handles config write failure", async () => {
    const app = Fastify();
    const { writeConfig } = await import("../src/configPersistence.js");
    vi.mocked(writeConfig).mockRejectedValueOnce(new Error("Write error"));

    await setupRoutes(app, {});

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        databaseUrl: "postgres://",
        redisUrl: "redis://",
        adminEmail: "admin@example.com",
        adminPassword: "password123",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.payload)).toEqual({
      code: "CONFIG_WRITE_FAILED",
      message: "Write error"
    });
  });

  it("POST /api/v1/setup/complete handles onSetupComplete throwing", async () => {
    const app = Fastify();
    let setupCompleteCalled = false;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    await setupRoutes(app, {
      onSetupComplete: async () => {
        setupCompleteCalled = true;
        throw new Error("Setup error");
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        databaseUrl: "postgres://",
        redisUrl: "redis://",
        adminEmail: "admin@example.com",
        adminPassword: "password123",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      ok: true,
      tenantId: "t-default",
      adminEmail: "admin@example.com"
    });
    expect(setupCompleteCalled).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith("[setup] Hot-reload after setup failed:", expect.any(Error));
    consoleSpy.mockRestore();
  });

  it("returns 400 on missing databaseUrl for test-database", async () => {
    const app = Fastify();
    await setupRoutes(app, {});
    const res = await app.inject({ method: "POST", url: "/api/v1/setup/test-database", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on missing redisUrl for test-redis", async () => {
    const app = Fastify();
    await setupRoutes(app, {});
    const res = await app.inject({ method: "POST", url: "/api/v1/setup/test-redis", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on missing databaseUrl for tenants", async () => {
    const app = Fastify();
    await setupRoutes(app, {});
    const res = await app.inject({ method: "GET", url: "/api/v1/setup/tenants" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 409 on complete if setup already completed", async () => {
    const app = Fastify();
    const { isSetupRequired } = await import("../src/bootstrapEnv.js");
    vi.mocked(isSetupRequired).mockReturnValueOnce(false);
    await setupRoutes(app, {});
    const res = await app.inject({ method: "POST", url: "/api/v1/setup/complete", payload: {} });
    expect(res.statusCode).toBe(409);
  });

  it("returns 400 on missing fields for complete", async () => {
    const app = Fastify();
    await setupRoutes(app, {});
    const res = await app.inject({ method: "POST", url: "/api/v1/setup/complete", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("returns 422 on database setup failure", async () => {
    const app = Fastify();
    const { ensureCoreSchema } = await import("@sm/db");
    vi.mocked(ensureCoreSchema).mockRejectedValueOnce(new Error("db fail"));
    await setupRoutes(app, {});
    const res = await app.inject({ method: "POST", url: "/api/v1/setup/complete", payload: {
      databaseUrl: "postgres://", redisUrl: "redis://", adminEmail: "x@x.com", adminPassword: "password123"
    } });
    expect(res.statusCode).toBe(422);
  });
});
