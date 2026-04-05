import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorSchema } from "@sm/contracts";
import { __resetEnrollmentStoreForTests } from "../src/enrollmentStore.js";
import { buildServer } from "../src/server.js";

const app = buildServer();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
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
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("KAIAD_SETUP_COMPLETE", "");
      vi.stubEnv("KAIAD_SETUP_REQUIRED", "1");
      const setupApp = buildServer();
      await setupApp.ready();
      const response = await setupApp.inject({ method: "GET", url: "/api/v1/setup/status" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          setupRequired: true,
          setupComplete: false
        })
      );
      await setupApp.close();
    });

    it("returns SETUP_REQUIRED for non-setup API routes while setup is pending", async () => {
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
      payload: { tenantId: "t-2", githubRepo: "o/r", defaultBranch: "main" }
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects invalid webhook signature", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: { hello: "world" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("accepts valid webhook signature", async () => {
    const payload = JSON.stringify({ hello: "world" });
    const sig = crypto.createHmac("sha256", "test-secret").update(payload).digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${sig}`
      }
    });
    expect(response.statusCode).toBe(200);
  });

  describe("github webhook enqueue (injected)", () => {
    const enqueue = vi.fn();
    const hooked = buildServer({ enqueueGithubJob: enqueue });

    beforeAll(async () => {
      await hooked.ready();
    });

    afterAll(async () => {
      await hooked.close();
    });

    it("valid webhook enqueues exactly one job payload", async () => {
      enqueue.mockClear();
      const payload = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "acme/app" },
        installation: { id: 7 }
      });
      const sig = crypto.createHmac("sha256", "test-secret").update(payload).digest("hex");
      const response = await hooked.inject({
        method: "POST",
        url: "/webhooks/github",
        payload,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${sig}`,
          "x-github-event": "push"
        }
      });
      expect(response.statusCode).toBe(200);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        kind: "github_mutation",
        tenantId: "t-webhook",
        installationId: 7,
        action: "push",
        repo: "acme/app",
        branch: "main"
      }));
    });

    it("invalid signature enqueues none", async () => {
      enqueue.mockClear();
      const response = await hooked.inject({
        method: "POST",
        url: "/webhooks/github",
        payload: { x: 1 }
      });
      expect(response.statusCode).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/github/policy/check", () => {
    it("returns 401 when unauthenticated", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/github/policy/check",
        payload: { repo: "o/r", branch: "main", action: "create_pr" }
      });
      expect(response.statusCode).toBe(401);
    });

    it("returns allowed=true for allowlisted repo/branch/action", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/settings",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          tenantId: "t-1",
          githubRepo: "o/r",
          defaultBranch: "main",
          automationPolicy: {
            repos: ["acme/repo"],
            branches: ["main"],
            actions: ["create_pr"]
          }
        }
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/github/policy/check",
        headers: { authorization: "Bearer dev-token" },
        payload: { repo: "acme/repo", branch: "main", action: "create_pr" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ allowed: true });
    });

    it("returns 403 with reason POLICY_DENY when blocked", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/settings",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          tenantId: "t-1",
          githubRepo: "o/r",
          defaultBranch: "main",
          automationPolicy: {
            repos: ["acme/repo"],
            branches: ["main"],
            actions: ["push"]
          }
        }
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/github/policy/check",
        headers: { authorization: "Bearer dev-token" },
        payload: { repo: "acme/repo", branch: "main", action: "create_pr" }
      });
      expect(response.statusCode).toBe(403);
      const body = response.json() as { code: string };
      expect(body.code).toBe("POLICY_DENY");
    });
  });

  describe.sequential("GitHub App installations", () => {
    it("returns 401 for GET when unauthenticated", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/github/installations" });
      expect(response.statusCode).toBe(401);
    });

    it("returns 401 for POST when unauthenticated", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/github/installations",
        payload: { installationId: 1, accountLogin: "acme", appId: 99 }
      });
      expect(response.statusCode).toBe(401);
    });

    it("upserts installation for session tenant", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/github/installations",
        headers: { authorization: "Bearer dev-token" },
        payload: { installationId: 42, accountLogin: "acme-corp", appId: 12345 }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        installationId: 42,
        accountLogin: "acme-corp",
        appId: 12345
      });
    });

    it("lists installations for current tenant", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/github/installations",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        installations: [{ installationId: 42, accountLogin: "acme-corp", appId: 12345 }]
      });
    });

    it("denies POST when tenantId does not match session", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/github/installations",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          tenantId: "t-other",
          installationId: 99,
          accountLogin: "other",
          appId: 1
        }
      });
      expect(response.statusCode).toBe(403);
    });

    it("sync endpoint returns 401 when unauthenticated", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/github/installations/sync",
        payload: { installationId: 88 }
      });
      expect(response.statusCode).toBe(401);
    });

    it("sync endpoint returns 503 when GitHub app credentials are missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/github/installations/sync",
        headers: { authorization: "Bearer dev-token" },
        payload: { installationId: 88 }
      });
      expect(response.statusCode).toBe(503);
    });

    it("syncs installation metadata using GitHub app credentials", async () => {
      const keypair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" }
      });
      vi.stubEnv("GITHUB_APP_ID", "12345");
      vi.stubEnv("GITHUB_APP_PRIVATE_KEY", keypair.privateKey);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 88, account: { login: "acme-sync" }, app_id: 12345 })
      } as Response);

      try {
        const syncResponse = await app.inject({
          method: "POST",
          url: "/api/v1/github/installations/sync",
          headers: { authorization: "Bearer dev-token" },
          payload: { installationId: 88 }
        });
        expect(syncResponse.statusCode).toBe(200);
        expect(syncResponse.json()).toEqual({
          installationId: 88,
          accountLogin: "acme-sync",
          appId: 12345
        });

        const listResponse = await app.inject({
          method: "GET",
          url: "/api/v1/github/installations",
          headers: { authorization: "Bearer dev-token" }
        });
        expect(listResponse.statusCode).toBe(200);
        expect(listResponse.json()).toEqual({
          installations: [{ installationId: 88, accountLogin: "acme-sync", appId: 12345 }]
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
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
    });

    it("lists active tokens without plaintext token field", async () => {
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
    });

    it("fails closed when durable enrollment store is not configured", async () => {
      vi.stubEnv("SM_ENROLLMENT_STORE", "");
      vi.stubEnv("DATABASE_URL", "");
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
      expect(JSON.parse(helloRaw)).toEqual({ type: "hello", service: "realtime" });

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
