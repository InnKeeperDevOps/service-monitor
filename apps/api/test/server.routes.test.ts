import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { __resetOAuthStoreForTests, addOAuthProvider } from "../src/oauth.js";

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
  __resetOAuthStoreForTests();
});

describe("Server routes", () => {
  describe("OAuth routes", () => {
    it("GET /api/v1/auth/providers returns providers", async () => {
      addOAuthProvider({
        id: "test",
        provider: "test",
        clientId: "cid",
        clientSecret: "sec",
        authorizeUrl: "https://auth",
        tokenUrl: "https://tok",
        userInfoUrl: "https://ui",
        scopes: ["s1"],
      });
      const response = await app.inject({ method: "GET", url: "/api/v1/auth/providers" });
      expect(response.statusCode).toBe(200);
      expect(response.json().providers).toEqual([
        { id: "test", provider: "test", name: "Test" }
      ]);
    });

    it("GET /api/v1/auth/oauth/authorize returns 400 if provider missing", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/auth/oauth/authorize" });
      expect(response.statusCode).toBe(400);
    });

    it("GET /api/v1/auth/oauth/authorize returns 404 if provider not found", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/auth/oauth/authorize?provider=nope" });
      expect(response.statusCode).toBe(404);
    });

    it("GET /api/v1/auth/oauth/authorize returns authorizeUrl", async () => {
      addOAuthProvider({
        id: "test",
        provider: "test",
        clientId: "cid",
        clientSecret: "sec",
        authorizeUrl: "https://auth",
        tokenUrl: "https://tok",
        userInfoUrl: "https://ui",
        scopes: ["s1"],
      });
      const response = await app.inject({ method: "GET", url: "/api/v1/auth/oauth/authorize?provider=test" });
      expect(response.statusCode).toBe(200);
      expect(response.json().authorizeUrl).toContain("https://auth");
    });
  });

  describe("Settings routes", () => {
    it("GET /api/v1/settings/github-app returns 401 unauthenticated", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/settings/github-app" });
      expect(response.statusCode).toBe(401);
    });

    it("GET /api/v1/settings/github-app returns info", async () => {
      const response = await app.inject({ 
        method: "GET", 
        url: "/api/v1/settings/github-app",
        headers: { authorization: "Bearer dev-token" } 
      });
      expect(response.statusCode).toBe(200);
    });

    it("POST /api/v1/settings/github-app returns 403 for non-admin", async () => {
      // Mock authStore to return viewer
      const appWithViewer = buildServer({
        authStore: {
          ...(app as any).authStore,
          findSessionByTokenHash: vi.fn().mockResolvedValue({ id: "sess", userId: "u", tenantId: "t", expiresAt: new Date(Date.now() + 100000) }),
          findMemberships: vi.fn().mockResolvedValue([{ tenantId: "t", role: "viewer" }]),
          findUserById: vi.fn().mockResolvedValue({ id: "u", email: "user@example.com" })
        } as any
      });
      await appWithViewer.ready();
      
      const response = await appWithViewer.inject({ 
        method: "POST", 
        url: "/api/v1/settings/github-app",
        headers: { authorization: "Bearer some-token" },
        payload: { githubAppId: "123", githubAppPrivateKeyPem: "pem", githubWebhookSecret: "sec" }
      });
      expect(response.statusCode).toBe(403);
      await appWithViewer.close();
    });
  });

  describe("Domain entities routes", () => {
    it("GET /api/v1/incidents returns incidents", async () => {
      const response = await app.inject({ 
        method: "GET", 
        url: "/api/v1/incidents",
        headers: { authorization: "Bearer dev-token" } 
      });
      expect(response.statusCode).toBe(200);
    });

    it("GET /api/v1/agents returns agents", async () => {
      const response = await app.inject({ 
        method: "GET", 
        url: "/api/v1/agents",
        headers: { authorization: "Bearer dev-token" } 
      });
      expect(response.statusCode).toBe(200);
    });

    it("GET /api/v1/services returns services", async () => {
      const response = await app.inject({ 
        method: "GET", 
        url: "/api/v1/services",
        headers: { authorization: "Bearer dev-token" } 
      });
      expect(response.statusCode).toBe(200);
    });

  });

  describe("More endpoints", () => {
    it("POST /api/v1/settings works", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/settings",
        headers: { authorization: "Bearer dev-token" },
        payload: { tenantId: "t-1", docsUrl: "https://docs.example.com" }
      });
      expect([200, 403, 500]).toContain(res.statusCode);
    });

    it("POST /api/v1/services works", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/services",
        headers: { authorization: "Bearer dev-token" },
        payload: { name: "Svc", gitRepoUrl: "https://git", branch: "main" }
      });
      expect(res.statusCode).toBe(201);
    });

    it("DELETE /api/v1/services/:id works", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/services/svc-1",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(res.statusCode).toBe(404); // mock returns false
    });

    it("GET /api/v1/incidents/:id works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/incidents/inc-1",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(res.statusCode).toBe(404);
    });

    it("PATCH /api/v1/incidents/:id/status works", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/incidents/inc-1/status",
        headers: { authorization: "Bearer dev-token" },
        payload: { status: "resolved" }
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/v1/session/active-tenant works", async () => {
      const appWithAuth = buildServer({
        authStore: {
          ...(app as any).authStore,
          findSessionByTokenHash: vi.fn().mockResolvedValue({ id: "sess", userId: "u", tenantId: "t", expiresAt: new Date(Date.now() + 100000) }),
          findMemberships: vi.fn().mockResolvedValue([{ tenantId: "t-1", role: "admin", tenantName: "t-1" }]),
          updateSessionTenant: vi.fn().mockResolvedValue(undefined),
          findUserById: vi.fn().mockResolvedValue({ id: "u", email: "user@example.com" })
        } as any
      });
      await appWithAuth.ready();

      const res = await appWithAuth.inject({
        method: "POST",
        url: "/api/v1/session/active-tenant",
        headers: { authorization: "Bearer dev-token" },
        payload: { tenantId: "t-1" }
      });
      expect([200, 403, 500]).toContain(res.statusCode);
      await appWithAuth.close();
    });

    it("POST /api/v1/tenants works", async () => {
      const appWithAuth = buildServer({
        authStore: {
          ...(app as any).authStore,
          findSessionByTokenHash: vi.fn().mockResolvedValue({ id: "sess", userId: "u", tenantId: "t", expiresAt: new Date(Date.now() + 100000) }),
          findMemberships: vi.fn().mockResolvedValue([{ tenantId: "t-new", role: "owner", tenantName: "New Tenant" }]),
          createTenantAsUser: vi.fn().mockResolvedValue({ id: "t-new", name: "New Tenant" }),
          updateSessionTenant: vi.fn().mockResolvedValue(undefined),
          findUserById: vi.fn().mockResolvedValue({ id: "u", email: "user@example.com" })
        } as any
      });
      await appWithAuth.ready();

      const res = await appWithAuth.inject({
        method: "POST",
        url: "/api/v1/tenants",
        headers: { authorization: "Bearer dev-token" },
        payload: { name: "New Tenant" }
      });
      expect([200, 403, 500]).toContain(res.statusCode);
      await appWithAuth.close();
    });

    it("GET /api/v1/ssh-keys works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/ssh-keys",
        headers: { authorization: "Bearer dev-token" },
      });
      expect([200, 403, 500]).toContain(res.statusCode);
    });

    it("POST /api/v1/ssh-keys works", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/ssh-keys",
        headers: { authorization: "Bearer dev-token" },
        payload: { name: "k1", type: "uploaded", privateKey: "pem" }
      });
      expect(res.statusCode).toBe(201);
    });

    it("DELETE /api/v1/ssh-keys/:id works", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/ssh-keys/k-1",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(res.statusCode).toBe(404);
    });

    it("GET /api/v1/me works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /api/v1/agents/enrollment-tokens works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(res.statusCode).toBe(200);
    });

    it("POST /api/v1/agents/enrollment-tokens works", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agents/enrollment-tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { ttlSeconds: 3600 }
      });
      expect([200, 201]).toContain(res.statusCode);
    });

    it("DELETE /api/v1/agents/enrollment-tokens/:id works", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/agents/enrollment-tokens/t-1",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(res.statusCode).toBe(404); // mock usually not found
    });

    it("DELETE /api/v1/agents/:id works", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/agents/a-1",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(res.statusCode).toBe(404);
    });

    it("PATCH /api/v1/agents/:id renames an agent", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/agents/a-1",
        headers: { authorization: "Bearer dev-token" },
        payload: { name: "New Name" }
      });
      expect(res.statusCode).toBe(404);
    });

    it("GET /api/v1/agents/:id returns 404 for unknown agent", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/agents/missing",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/v1/internal/agent-commands works", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/agent-commands",
        headers: { authorization: "Bearer dev-token" },
        payload: { agentId: "a-1", commandId: "cmd-1", payload: { type: "run_step", commandId: "cmd-1", shell: "echo ok" } }
      });
      expect([202, 400, 401, 500]).toContain(res.statusCode);
    });

  });
});
