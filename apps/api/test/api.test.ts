import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorSchema } from "@sm/contracts";
import * as configPersistence from "../src/configPersistence.js";
import { __resetEnrollmentStoreForTests } from "../src/enrollmentStore.js";
import {
  addMemoryMembershipForTests,
  createMemoryAuthStore,
  seedDevUser,
  __resetAuthStoreForTests
} from "../src/memoryAuthStore.js";
import { buildServer } from "../src/server.js";
import { upsertTenantSettings, __resetTenantStoreForTests } from "../src/store.js";

const app = buildServer();

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  process.env.SM_ENROLLMENT_STORE = "memory";
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  process.env.SM_ENROLLMENT_STORE = "memory";
});

describe("api", () => {
  it("returns health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  describe("/ready dependency checks", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns 200 when no dependencies are configured (injected empty checkers)", async () => {
      const server = buildServer({ readinessCheckers: [] });
      await server.ready();
      const response = await server.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
      await server.close();
    });

    it("returns 200 when POSTGRES_* / REDIS_* env vars are absent", async () => {
      vi.stubEnv("POSTGRES_HOST", "");
      vi.stubEnv("POSTGRES_PORT", "");
      vi.stubEnv("REDIS_HOST", "");
      vi.stubEnv("REDIS_PORT", "");
      const server = buildServer();
      await server.ready();
      const response = await server.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
      await server.close();
    });

    it("returns 503 when Redis is configured but unreachable", async () => {
      vi.stubEnv("POSTGRES_HOST", "");
      vi.stubEnv("POSTGRES_PORT", "");
      vi.stubEnv("REDIS_HOST", "127.0.0.1");
      vi.stubEnv("REDIS_PORT", "1");
      const server = buildServer();
      await server.ready();
      const response = await server.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(503);
      const body = response.json() as { status: string; code: string; message: string };
      expect(body.status).toBe("not_ready");
      expect(body.code).toBe("REDIS_UNAVAILABLE");
      expect(body.message).toContain("Redis dependency check failed");
      await server.close();
    });

    it("returns 503 when Postgres is configured but unreachable", async () => {
      vi.stubEnv("POSTGRES_HOST", "127.0.0.1");
      vi.stubEnv("POSTGRES_PORT", "1");
      vi.stubEnv("REDIS_HOST", "");
      vi.stubEnv("REDIS_PORT", "");
      const server = buildServer();
      await server.ready();
      const response = await server.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(503);
      const body = response.json() as { status: string; code: string; message: string };
      expect(body.status).toBe("not_ready");
      expect(body.code).toBe("POSTGRES_UNAVAILABLE");
      expect(body.message).toContain("Postgres dependency check failed");
      await server.close();
    });

    it("returns 200 when injected checkers report both dependencies reachable", async () => {
      const server = buildServer({
        readinessCheckers: [async () => ({ ok: true }), async () => ({ ok: true })]
      });
      await server.ready();
      const response = await server.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
      await server.close();
    });
  });

  describe("setup-required mode", () => {
    it("exposes setup status when DATABASE_URL is absent", async () => {
      vi.stubEnv("KAIAD_SKIP_SETUP_GATE", "");
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("KAIAD_SETUP_COMPLETE", "");
      vi.stubEnv("KAIAD_SETUP_REQUIRED", "1");
      const setupApp = buildServer();
      await setupApp.ready();
      const response = await setupApp.inject({ method: "GET", url: "/api/v1/setup/status" });
      expect(response.statusCode).toBe(200);
      const status = response.json() as { setupRequired: boolean; version: string };
      expect(status.setupRequired).toBe(true);
      expect(status.version.length).toBeGreaterThan(0);
      await setupApp.close();
    });

    it("returns SETUP_REQUIRED for non-setup API routes while setup is pending", async () => {
      vi.stubEnv("KAIAD_SKIP_SETUP_GATE", "");
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("KAIAD_SETUP_COMPLETE", "");
      vi.stubEnv("KAIAD_SETUP_REQUIRED", "1");
      const setupApp = buildServer();
      await setupApp.ready();
      const response = await setupApp.inject({ method: "GET", url: "/api/v1/me" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(
        expect.objectContaining({
          code: "SETUP_REQUIRED"
        })
      );
      await setupApp.close();
    });
  });

  it("requires auth for /api/v1/me", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(response.statusCode).toBe(401);
  });

  it("supports authenticated /api/v1/me", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: "Bearer dev-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tenantId).toBe("t-1");
  });

  describe("POST /api/v1/internal/agent-commands", () => {
    it("returns 401 when missing internal token", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/internal/agent-commands",
        payload: {
          agentId: "a-1",
          commandId: "cmd-1",
          payload: { type: "run_step", shell: "echo hi", env: {} }
        }
      });
      expect(response.statusCode).toBe(401);
    });

    it("queues command to realtime manager when authorized", async () => {
      const internalApp = buildServer();
      await internalApp.ready();
      const sendSpy = vi.spyOn((internalApp as any).realtimeManager, "sendCommand").mockResolvedValue({
        queued: false,
        delivered: false
      });
      const response = await internalApp.inject({
        method: "POST",
        url: "/api/v1/internal/agent-commands",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          agentId: "a-1",
          commandId: "cmd-1",
          payload: { type: "run_step", shell: "echo hi", env: {} }
        }
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        accepted: true,
        commandId: "cmd-1",
        queued: false,
        delivered: false
      });
      expect(sendSpy).toHaveBeenCalledWith(
        "a-1",
        JSON.stringify({ type: "run_step", commandId: "cmd-1", shell: "echo hi", env: {} })
      );
      await internalApp.close();
    });

    it("fails closed in production when INTERNAL_API_TOKEN is not configured", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("INTERNAL_API_TOKEN", "");
      vi.stubEnv("DATABASE_URL", "postgres://example.invalid/db");
      const internalApp = buildServer();
      await internalApp.ready();
      const response = await internalApp.inject({
        method: "POST",
        url: "/api/v1/internal/agent-commands",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          agentId: "a-1",
          commandId: "cmd-1",
          payload: { type: "run_step", shell: "echo hi", env: {} }
        }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(
        expect.objectContaining({
          code: "INTERNAL_TOKEN_UNCONFIGURED"
        })
      );
      await internalApp.close();
    });
  });

  it("blocks cross-tenant settings writes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/settings",
      headers: { authorization: "Bearer dev-token" },
      payload: { tenantId: "t-2", docsUrl: "https://docs.example.com" }
    });
    expect(response.statusCode).toBe(403);
  });

  describe.sequential("agent enrollment tokens", () => {
    beforeEach(async () => {
      vi.stubEnv("SM_ENROLLMENT_STORE", "memory");
      await __resetEnrollmentStoreForTests();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns 401 for POST when unauthenticated", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens",
        payload: { ttlSeconds: 3600 }
      });
      expect(response.statusCode).toBe(401);
    });

    it("returns 401 for GET when unauthenticated", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/agents/enrollment-tokens" });
      expect(response.statusCode).toBe(401);
    });

    it("returns 401 for DELETE when unauthenticated", async () => {
      const response = await app.inject({ method: "DELETE", url: "/api/v1/agents/enrollment-tokens/tok_unauthorized" });
      expect(response.statusCode).toBe(401);
    });

    it("returns 401 for POST deactivate when unauthenticated", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens/tok_unauthorized/deactivate"
      });
      expect(response.statusCode).toBe(401);
    });

    it("creates a token and returns plaintext once with metadata", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { ttlSeconds: 7200 }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(typeof body.token).toBe("string");
      expect((body.token as string).length).toBeGreaterThan(16);
      expect(body.id).toBeTruthy();
      expect(body.tenantId).toBe("t-1");
      expect(body.createdBy).toBe("u-1");
      expect(body.usedAt).toBeNull();
      expect(body.isActive).toBe(true);
    });

    it("lists enrollment tokens (active and inactive) without plaintext token field", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { ttlSeconds: 86400 }
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { tokens: Record<string, unknown>[] };
      expect(body.tokens).toHaveLength(1);
      const row = body.tokens[0]!;
      expect(row).not.toHaveProperty("token");
      expect(row.id).toBeTruthy();
      expect(row.tenantId).toBe("t-1");
      expect(row.isActive).toBe(true);
    });

    it("marks a token inactive after it is consumed", async () => {
      const createdResponse = await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { ttlSeconds: 3600 }
      });
      const created = createdResponse.json() as { token: string; id: string };

      const ws = await app.injectWS(`/realtime?token=${encodeURIComponent(created.token)}`);
      ws.close();

      const listedResponse = await app.inject({
        method: "GET",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(listedResponse.statusCode).toBe(200);
      const listed = listedResponse.json() as {
        tokens: { id: string; isActive: boolean; usedAt: string | null }[];
      };
      expect(listed.tokens).toHaveLength(1);
      expect(listed.tokens[0]?.id).toBe(created.id);
      expect(listed.tokens[0]?.isActive).toBe(false);
      expect(listed.tokens[0]?.usedAt).not.toBeNull();
    });

    it("allows reconnect with the same plaintext token while it is not revoked or expired", async () => {
      const createdResponse = await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { ttlSeconds: 3600 }
      });
      const created = createdResponse.json() as { token: string; id: string };

      const firstWs = await app.injectWS(`/realtime?token=${encodeURIComponent(created.token)}`);
      firstWs.close();
      await new Promise<void>((resolve) => firstWs.once("close", resolve));

      // Same plaintext token used again — must still resolve (not receive INVALID_TOKEN).
      let resolveFrame!: (v: string) => void;
      const framePromise = new Promise<string>((res) => {
        resolveFrame = res;
      });
      const secondWs = await app.injectWS(
        `/realtime?token=${encodeURIComponent(created.token)}`,
        {},
        {
          onInit: (sock) => {
            sock.once("message", (d) => resolveFrame(d.toString()));
          }
        }
      );
      const firstFrame = JSON.parse(await framePromise);
      expect(firstFrame.type).toBe("hello");
      secondWs.close();
    });

    it("closes the socket with INVALID_TOKEN when the token does not exist", async () => {
      let resolveFrame!: (v: string) => void;
      const framePromise = new Promise<string>((res) => {
        resolveFrame = res;
      });
      const ws = await app.injectWS(
        `/realtime?token=${encodeURIComponent("not-a-real-token")}`,
        {},
        {
          onInit: (sock) => {
            sock.once("message", (d) => resolveFrame(d.toString()));
          }
        }
      );
      const frame = JSON.parse(await framePromise);
      expect(frame).toEqual(
        expect.objectContaining({ code: "INVALID_TOKEN" })
      );
      await new Promise<void>((resolve) => ws.once("close", resolve));
    });

    it("deactivates an active enrollment token", async () => {
      const createdResponse = await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { ttlSeconds: 3600 }
      });
      const created = createdResponse.json() as { id: string; isActive: boolean; revokedAt: string | null };
      expect(created.isActive).toBe(true);
      expect(created.revokedAt).toBeNull();

      const deactivateResponse = await app.inject({
        method: "POST",
        url: `/api/v1/agents/enrollment-tokens/${created.id}/deactivate`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(deactivateResponse.statusCode).toBe(204);

      const listedResponse = await app.inject({
        method: "GET",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" }
      });
      const listed = listedResponse.json() as {
        tokens: { id: string; isActive: boolean; revokedAt: string | null; usedAt: string | null }[];
      };
      expect(listed.tokens).toHaveLength(1);
      expect(listed.tokens[0]?.id).toBe(created.id);
      expect(listed.tokens[0]?.isActive).toBe(false);
      expect(listed.tokens[0]?.revokedAt).not.toBeNull();
      expect(listed.tokens[0]?.usedAt).toBeNull();

      const again = await app.inject({
        method: "POST",
        url: `/api/v1/agents/enrollment-tokens/${created.id}/deactivate`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(again.statusCode).toBe(409);
    });

    it("deletes enrollment token by id", async () => {
      const createdResponse = await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { ttlSeconds: 3600 }
      });
      const created = createdResponse.json() as { id: string };

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/v1/agents/enrollment-tokens/${created.id}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(deleteResponse.statusCode).toBe(204);

      const listedResponse = await app.inject({
        method: "GET",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(listedResponse.statusCode).toBe(200);
      const listed = listedResponse.json() as { tokens: { id: string }[] };
      expect(listed.tokens).toHaveLength(0);
    });

    it("fails closed when durable enrollment store is not configured", async () => {
      vi.stubEnv("SM_ENROLLMENT_STORE", "");
      vi.stubEnv("DATABASE_URL", "postgres://test:test@127.0.0.1:65531/unreachable_enrollment");
      await __resetEnrollmentStoreForTests();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { ttlSeconds: 3600 }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(
        expect.objectContaining({
          code: "ENROLLMENT_STORE_UNAVAILABLE"
        })
      );
    });
  });

  describe.sequential("WebSocket /realtime", () => {
    beforeEach(() => {
      vi.stubEnv("DATABASE_URL", "");
      __resetTenantStoreForTests();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      __resetTenantStoreForTests();
    });

    it("sends hello then ack for a valid heartbeat", async () => {
      let resolveHello!: (v: string) => void;
      const helloPromise = new Promise<string>((res) => {
        resolveHello = res;
      });
      const ws = await app.injectWS("/realtime", {}, {
        onInit: (sock) => {
          sock.once("message", (d) => resolveHello(d.toString()));
        }
      });
      const helloRaw = await helloPromise;
      expect(JSON.parse(helloRaw)).toEqual(
        expect.objectContaining({
          type: "hello",
          service: "realtime",
          runtime: { backend: "docker" }
        })
      );

      const ackPromise = new Promise<string>((resolve, reject) => {
        ws.once("message", (d) => resolve(d.toString()));
        ws.once("error", reject);
      });
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          agentId: "a-test",
          ts: new Date().toISOString(),
          capacity: 2
        })
      );
      const ackRaw = await ackPromise;
      expect(JSON.parse(ackRaw)).toEqual({ type: "ack", accepted: true });
      ws.close();
    });

    it("sends hello then ack for a valid host_stats", async () => {
      let resolveHello!: (v: string) => void;
      const helloPromise = new Promise<string>((res) => {
        resolveHello = res;
      });
      const ws = await app.injectWS("/realtime", {}, {
        onInit: (sock) => {
          sock.once("message", (d) => resolveHello(d.toString()));
        }
      });
      await helloPromise;

      const ackPromise = new Promise<string>((resolve, reject) => {
        ws.once("message", (d) => resolve(d.toString()));
        ws.once("error", reject);
      });
      ws.send(
        JSON.stringify({
          type: "host_stats",
          agentId: "a-stats",
          ts: new Date().toISOString(),
          cpuPercent: 3.5,
          memUsedBytes: 1000,
          memTotalBytes: 8000,
          netRxBytesPerSec: 10,
          netTxBytesPerSec: 20
        })
      );
      const ackRaw = await ackPromise;
      expect(JSON.parse(ackRaw)).toEqual({ type: "ack", accepted: true });
      ws.close();
    });

    it("surfaces latest host_stats as telemetry on GET /api/v1/agents", async () => {
      let resolveHello!: (v: string) => void;
      const helloPromise = new Promise<string>((res) => {
        resolveHello = res;
      });
      const ws = await app.injectWS("/realtime", {}, {
        onInit: (sock) => {
          sock.once("message", (d) => resolveHello(d.toString()));
        }
      });
      await helloPromise;

      const ackPromise = new Promise<string>((resolve, reject) => {
        ws.once("message", (d) => resolve(d.toString()));
        ws.once("error", reject);
      });
      const sampleTs = new Date().toISOString();
      ws.send(
        JSON.stringify({
          type: "host_stats",
          agentId: "a-telemetry",
          ts: sampleTs,
          cpuPercent: 42.5,
          memUsedBytes: 2_000_000,
          memTotalBytes: 8_000_000,
          memPercent: 25,
          netRxBytesPerSec: 1024,
          netTxBytesPerSec: 2048,
          processRSSBytes: 512_000
        })
      );
      await ackPromise;

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { agents: Array<{ id: string; telemetry?: Record<string, unknown> }> };
      const row = body.agents.find((a) => a.id === "a-telemetry");
      expect(row?.telemetry).toEqual(
        expect.objectContaining({
          ts: sampleTs,
          cpuPercent: 42.5,
          memUsedBytes: 2_000_000,
          memTotalBytes: 8_000_000,
          memPercent: 25,
          netRxBytesPerSec: 1024,
          netTxBytesPerSec: 2048,
          processRSSBytes: 512_000
        })
      );
      ws.close();
    });

    it("surfaces app_stats frames as apps on GET /api/v1/agents", async () => {
      let resolveHello!: (v: string) => void;
      const helloPromise = new Promise<string>((res) => {
        resolveHello = res;
      });
      const ws = await app.injectWS("/realtime", {}, {
        onInit: (sock) => {
          sock.once("message", (d) => resolveHello(d.toString()));
        }
      });
      await helloPromise;

      const ackPromise = new Promise<string>((resolve, reject) => {
        ws.once("message", (d) => resolve(d.toString()));
        ws.once("error", reject);
      });
      const ts = new Date().toISOString();
      ws.send(
        JSON.stringify({
          type: "app_stats",
          agentId: "a-app-telemetry",
          ts,
          containerId: "deadbeef1234",
          name: "dev-kaiad-1",
          image: "dev-kaiad:latest",
          state: "running",
          cpuPercent: 12.3,
          memUsedBytes: 50_000_000,
          memLimitBytes: 200_000_000,
          memPercent: 25,
          netRxBytesPerSec: 100,
          netTxBytesPerSec: 200
        })
      );
      await ackPromise;

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agents",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        agents: Array<{ id: string; apps?: Array<Record<string, unknown>> }>;
      };
      const row = body.agents.find((a) => a.id === "a-app-telemetry");
      expect(row?.apps).toHaveLength(1);
      expect(row?.apps?.[0]).toEqual(
        expect.objectContaining({
          containerId: "deadbeef1234",
          name: "dev-kaiad-1",
          cpuPercent: 12.3,
          memPercent: 25,
          netRxBytesPerSec: 100,
          netTxBytesPerSec: 200
        })
      );
      ws.close();
    });

    it("broadcasts host_stats and app_stats to UI telemetry subscribers", async () => {
      const uiMessages: string[] = [];
      let uiOpened!: () => void;
      const openPromise = new Promise<void>((res) => {
        uiOpened = res;
      });
      const uiWs = await app.injectWS("/api/v1/realtime/ui?token=dev-token", {}, {
        onInit: (sock) => {
          sock.on("message", (d) => {
            uiMessages.push(d.toString());
          });
        }
      });
      // Give the UI WS a moment to register.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      uiOpened();
      await openPromise;

      const agentWs = await app.injectWS("/realtime");
      // Wait for hello.
      await new Promise<void>((resolve) => agentWs.once("message", () => resolve()));

      const hostAck = new Promise<void>((resolve) => agentWs.once("message", () => resolve()));
      agentWs.send(
        JSON.stringify({
          type: "host_stats",
          agentId: "a-bcast",
          ts: new Date().toISOString(),
          cpuPercent: 4.2
        })
      );
      await hostAck;

      const appAck = new Promise<void>((resolve) => agentWs.once("message", () => resolve()));
      agentWs.send(
        JSON.stringify({
          type: "app_stats",
          agentId: "a-bcast",
          ts: new Date().toISOString(),
          containerId: "c-123",
          name: "svc",
          state: "running",
          cpuPercent: 8.8
        })
      );
      await appAck;

      // Give fanout a moment to land on the UI socket.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const events = uiMessages.map((m) => JSON.parse(m));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "host_stats", agentId: "a-bcast" }),
          expect.objectContaining({
            type: "app_stats",
            agentId: "a-bcast",
            containerId: "c-123"
          })
        ])
      );
      agentWs.close();
      uiWs.close();
    });

    it("sends apiError-like frame and closes on invalid JSON", async () => {
      let resolveHello!: (v: string) => void;
      const helloPromise = new Promise<string>((res) => {
        resolveHello = res;
      });
      const ws = await app.injectWS("/realtime", {}, {
        onInit: (sock) => {
          sock.once("message", (d) => resolveHello(d.toString()));
        }
      });
      await helloPromise;

      const errPromise = new Promise<string>((resolve, reject) => {
        ws.once("message", (d) => resolve(d.toString()));
        ws.once("error", reject);
      });
      ws.send("not-json{");
      const errorRaw = await errPromise;
      const err = apiErrorSchema.parse(JSON.parse(errorRaw));
      expect(err.code).toBe("INVALID_MESSAGE");
      await new Promise<void>((resolve) => ws.once("close", resolve));
    });

    it("enqueues log_event messages for log ingestion", async () => {
      const enqueuedLogs: unknown[] = [];
      const logServer = buildServer({
        enqueueLogIngestion: async (job) => { enqueuedLogs.push(job); }
      });
      await logServer.ready();
      let resolveHello!: (v: string) => void;
      const helloPromise = new Promise<string>((res) => {
        resolveHello = res;
      });
      const ws = await logServer.injectWS("/realtime", {}, {
        onInit: (sock) => {
          sock.once("message", (d) => resolveHello(d.toString()));
        }
      });
      await helloPromise;

      const ackPromise = new Promise<string>((resolve, reject) => {
        ws.once("message", (d) => resolve(d.toString()));
        ws.once("error", reject);
      });
      ws.send(
        JSON.stringify({
          type: "log_event",
          agentId: "a-test",
          serviceId: "svc-1",
          level: "error",
          message: "NullPointerException",
          ts: new Date().toISOString()
        })
      );
      const ackRaw = await ackPromise;
      expect(JSON.parse(ackRaw)).toEqual({ type: "ack", accepted: true });
      expect(enqueuedLogs).toHaveLength(1);
      expect((enqueuedLogs[0] as { serviceId: string }).serviceId).toBe("svc-1");
      ws.close();
      await logServer.close();
    });

    it("sends apiError-like frame and closes on JSON that fails schema", async () => {
      let resolveHello!: (v: string) => void;
      const helloPromise = new Promise<string>((res) => {
        resolveHello = res;
      });
      const ws = await app.injectWS("/realtime", {}, {
        onInit: (sock) => {
          sock.once("message", (d) => resolveHello(d.toString()));
        }
      });
      await helloPromise;

      const errPromise = new Promise<string>((resolve, reject) => {
        ws.once("message", (d) => resolve(d.toString()));
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ type: "not_a_real_message", x: 1 }));
      const errorRaw = await errPromise;
      const err = apiErrorSchema.parse(JSON.parse(errorRaw));
      expect(err.code).toBe("INVALID_MESSAGE");
      await new Promise<void>((resolve) => ws.once("close", resolve));
    });
  });
});
