import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashPassword,
  hashToken,
  login,
  resolveSession,
  verifyPassword,
  type AuthStore,
} from "../src/auth.js";
import {
  createMemoryAuthStore,
  seedDevUser,
  __resetAuthStoreForTests,
  addMemoryMembershipForTests
} from "../src/memoryAuthStore.js";
import { buildServer } from "../src/server.js";
import { upsertTenantSettings, __resetTenantStoreForTests } from "../src/store.js";
import {
  buildAuthorizeUrl,
  addOAuthProvider,
  getOAuthProvider,
  listProviders,
  generateState,
  consumeState,
  __resetOAuthStoreForTests,
  type OAuthProviderConfig,
} from "../src/oauth.js";

describe("auth utilities", () => {
  it("hashPassword + verifyPassword roundtrip", async () => {
    const hash = await hashPassword("supersecret");
    expect(await verifyPassword("supersecret", hash)).toBe(true);
  });

  it("verifyPassword rejects wrong password", async () => {
    const hash = await hashPassword("correct");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});

describe("login / resolveSession", () => {
  let store: AuthStore;

  beforeEach(async () => {
    __resetAuthStoreForTests();
    store = createMemoryAuthStore();
    await seedDevUser(store);
  });

  it("login succeeds with correct credentials", async () => {
    const result = await login(store, "admin@example.com", "admin");
    expect(result).not.toBeNull();
    expect(result!.session.email).toBe("admin@example.com");
    expect(result!.session.role).toBe("owner");
    expect(result!.session.tenantId).toBe("t-1");
    expect(typeof result!.token).toBe("string");
    expect(result!.token.length).toBeGreaterThan(0);
  });

  it("login fails with wrong password", async () => {
    const result = await login(store, "admin@example.com", "wrongpassword");
    expect(result).toBeNull();
  });

  it("resolveSession resolves dev-token in non-production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const session = await resolveSession(store, "Bearer dev-token");
    expect(session).not.toBeNull();
    expect(session!.email).toBe("admin@example.com");
    expect(session!.tenantId).toBe("t-1");
    process.env.NODE_ENV = prev;
  });

  it("resolveSession resolves dev-token in production when SM_ALLOW_DEV_TOKEN=1", async () => {
    const prevNode = process.env.NODE_ENV;
    const prevFlag = process.env.SM_ALLOW_DEV_TOKEN;
    process.env.NODE_ENV = "production";
    process.env.SM_ALLOW_DEV_TOKEN = "1";
    const session = await resolveSession(store, "Bearer dev-token");
    expect(session).not.toBeNull();
    expect(session!.tenantId).toBe("t-1");
    process.env.NODE_ENV = prevNode;
    process.env.SM_ALLOW_DEV_TOKEN = prevFlag;
  });

  it("resolveSession resolves a real session token after login", async () => {
    const result = await login(store, "admin@example.com", "admin");
    expect(result).not.toBeNull();
    const session = await resolveSession(store, `Bearer ${result!.token}`);
    expect(session).not.toBeNull();
    expect(session!.email).toBe("admin@example.com");
    expect(session!.tenantId).toBe("t-1");
  });

  it("resolveSession returns null for expired sessions", async () => {
    const result = await login(store, "admin@example.com", "admin");
    expect(result).not.toBeNull();

    const tokenHash = hashToken(result!.token);
    const sess = await store.findSessionByTokenHash(tokenHash);
    expect(sess).not.toBeNull();
    (sess as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);

    const session = await resolveSession(store, `Bearer ${result!.token}`);
    expect(session).toBeNull();
  });

  it("resolveSession returns null for invalid tokens", async () => {
    const session = await resolveSession(store, "Bearer totally-invalid-token");
    expect(session).toBeNull();
  });
});

describe("POST /api/v1/auth/login route", () => {
  let store: AuthStore;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    __resetAuthStoreForTests();
    store = createMemoryAuthStore();
    await seedDevUser(store);
    app = buildServer({ authStore: store });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns token on valid login", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.token).toBe("string");
    expect(body.user.email).toBe("admin@example.com");
  });

  it("returns 401 on invalid credentials", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "bad" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("INVALID_CREDENTIALS");
  });

  it("logs failure details on invalid credentials", async () => {
    const warnSpy = vi.spyOn(app.log, "warn");
    const infoSpy = vi.spyOn(app.log, "info");
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "admin@example.com", password: "bad" },
      });
      expect(response.statusCode).toBe(401);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "auth.login.failed",
          reason: "INVALID_PASSWORD",
          emailProvided: true,
          correlationId: expect.any(String)
        }),
        "Login attempt failed"
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "auth.login.step",
          step: "REQUEST_RECEIVED",
          emailProvided: true
        }),
        "Login step"
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "auth.login.step",
          step: "INVALID_PASSWORD",
          correlationId: expect.any(String)
        }),
        "Login step"
      );
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("returns 400 when email/password missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("BAD_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// OAuth unit tests
// ---------------------------------------------------------------------------

const testProvider: OAuthProviderConfig = {
  id: "test-gh",
  provider: "github",
  clientId: "cid-123",
  clientSecret: "csecret-456",
  authorizeUrl: "https://github.example.com/login/oauth/authorize",
  tokenUrl: "https://github.example.com/login/oauth/access_token",
  userInfoUrl: "https://api.github.example.com/user",
  scopes: ["user:email", "read:org"],
};

describe("buildAuthorizeUrl", () => {
  it("generates correct URL with all query params", () => {
    const url = buildAuthorizeUrl(testProvider, "http://localhost/callback", "state-abc");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(testProvider.authorizeUrl);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("cid-123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost/callback");
    expect(parsed.searchParams.get("state")).toBe("state-abc");
    expect(parsed.searchParams.get("scope")).toBe("user:email read:org");
  });
});

describe("in-memory OAuth provider store", () => {
  beforeEach(() => {
    __resetOAuthStoreForTests();
  });

  it("addOAuthProvider + getOAuthProvider roundtrip", () => {
    addOAuthProvider(testProvider);
    const got = getOAuthProvider("test-gh");
    expect(got).toEqual(testProvider);
  });

  it("listProviders returns summary entries", () => {
    addOAuthProvider(testProvider);
    const list = listProviders();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ id: "test-gh", provider: "github", name: "Github" });
  });

  it("generateState + consumeState roundtrip", () => {
    const state = generateState("test-gh");
    expect(typeof state).toBe("string");
    expect(state.length).toBeGreaterThan(0);
    const providerId = consumeState(state);
    expect(providerId).toBe("test-gh");
  });

  it("consumeState rejects reuse", () => {
    const state = generateState("test-gh");
    consumeState(state);
    expect(consumeState(state)).toBeNull();
  });

  it("consumeState rejects unknown state", () => {
    expect(consumeState("bogus")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth route tests
// ---------------------------------------------------------------------------

describe("OAuth routes", () => {
  let store: AuthStore;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    __resetAuthStoreForTests();
    __resetOAuthStoreForTests();
    store = createMemoryAuthStore();
    await seedDevUser(store);
    app = buildServer({ authStore: store });
    await app.ready();
    addOAuthProvider(testProvider);
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/v1/auth/providers", () => {
    it("lists configured providers (no auth required)", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/providers" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.providers).toHaveLength(1);
      expect(body.providers[0].id).toBe("test-gh");
      expect(body.providers[0].provider).toBe("github");
    });
  });

  describe("GET /api/v1/auth/oauth/authorize", () => {
    it("returns authorizeUrl with state", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth/authorize?provider=test-gh",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.authorizeUrl).toBe("string");
      const url = new URL(body.authorizeUrl);
      expect(url.searchParams.get("client_id")).toBe("cid-123");
      expect(url.searchParams.get("state")).toBeTruthy();
    });

    it("returns 400 without provider param", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/oauth/authorize" });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("BAD_REQUEST");
    });

    it("returns 404 for unknown provider", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth/authorize?provider=nope",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("PROVIDER_NOT_FOUND");
    });
  });

  describe("GET /api/v1/auth/oauth/callback", () => {
    it("returns 400 without code/state", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/oauth/callback" });
      expect(res.statusCode).toBe(400);
    });

    it("returns INVALID_STATE for bad state", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth/callback?code=abc&state=bad",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("INVALID_STATE");
    });

    it("exchanges code and returns token (mocked)", async () => {
      const state = generateState("test-gh");

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "at-123", token_type: "bearer" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ email: "oauth@example.com", sub: "ext-1", name: "OA User" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );

      const origFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;
      try {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/auth/oauth/callback?code=auth-code&state=${state}`,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(typeof body.token).toBe("string");
        expect(body.user.email).toBe("oauth@example.com");
        expect(body.user.role).toBeTruthy();

        expect(mockFetch).toHaveBeenCalledTimes(2);
        const tokenCall = mockFetch.mock.calls[0];
        expect(tokenCall[0]).toBe(testProvider.tokenUrl);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("POST /api/v1/settings/oauth-providers", () => {
    it("requires auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/settings/oauth-providers",
        payload: { id: "x", provider: "x", clientId: "x" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("adds a provider when admin", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/settings/oauth-providers",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          id: "gitlab",
          provider: "gitlab",
          clientId: "gl-cid",
          clientSecret: "gl-sec",
          authorizeUrl: "https://gitlab.com/oauth/authorize",
          tokenUrl: "https://gitlab.com/oauth/token",
          userInfoUrl: "https://gitlab.com/api/v4/user",
          scopes: ["read_user"],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(getOAuthProvider("gitlab")).toBeTruthy();
    });
  });
});


describe("multi-tenant /me and active-tenant", () => {
  let store: AuthStore;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    __resetAuthStoreForTests();
    __resetTenantStoreForTests();
    await upsertTenantSettings({
      tenantId: "t-1",
      gitRepoUrl: "org/tenant-a",
      defaultBranch: "main"
    });
    await upsertTenantSettings({
      tenantId: "t-2",
      gitRepoUrl: "org/tenant-b",
      defaultBranch: "main"
    });
    store = createMemoryAuthStore();
    await seedDevUser(store);
    addMemoryMembershipForTests({
      tenantId: "t-2",
      userId: "u-1",
      role: "viewer",
      tenantName: "Other org"
    });
    app = buildServer({ authStore: store });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    __resetTenantStoreForTests();
  });

  it("GET /me includes memberships", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    expect(loginRes.statusCode).toBe(200);
    const token = loginRes.json().token as string;
    const me = await app.inject({ url: "/api/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    const j = me.json();
    expect(Array.isArray(j.memberships)).toBe(true);
    expect(j.memberships.length).toBe(2);
    expect(j.tenantId).toBe("t-1");
  });

  it("POST /session/active-tenant switches tenant", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    const token = loginRes.json().token as string;

    const sw = await app.inject({
      method: "POST",
      url: "/api/v1/session/active-tenant",
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantId: "t-2" }
    });
    expect(sw.statusCode).toBe(200);
    expect(sw.json().tenantId).toBe("t-2");
    expect(sw.json().role).toBe("viewer");

    const me = await app.inject({ url: "/api/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json().tenantId).toBe("t-2");
  });

  it("GET /settings returns the active tenant row after switching", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    const token = loginRes.json().token as string;

    let settingsRes = await app.inject({
      url: "/api/v1/settings",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.json().gitRepoUrl).toBe("org/tenant-a");

    await app.inject({
      method: "POST",
      url: "/api/v1/session/active-tenant",
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantId: "t-2" }
    });

    settingsRes = await app.inject({
      url: "/api/v1/settings",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.json().gitRepoUrl).toBe("org/tenant-b");
  });

  it("POST /session/active-tenant returns 403 for non-member tenant", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    const token = loginRes.json().token as string;
    const sw = await app.inject({
      method: "POST",
      url: "/api/v1/session/active-tenant",
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantId: "t-nonexistent" }
    });
    expect(sw.statusCode).toBe(403);
  });
});

describe("POST /api/v1/tenants and DELETE /api/v1/tenants/:tenantId", () => {
  let store: AuthStore;
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    __resetAuthStoreForTests();
    __resetTenantStoreForTests();
    await upsertTenantSettings({
      tenantId: "t-1",
      gitRepoUrl: "org/a",
      defaultBranch: "main"
    });
    store = createMemoryAuthStore();
    await seedDevUser(store);
    addMemoryMembershipForTests({
      tenantId: "t-2",
      userId: "u-1",
      role: "admin",
      tenantName: "Second"
    });
    addMemoryMembershipForTests({
      tenantId: "t-3",
      userId: "u-1",
      role: "viewer",
      tenantName: "Third"
    });
    addMemoryMembershipForTests({
      tenantId: "t-4",
      userId: "u-1",
      role: "operator",
      tenantName: "Fourth"
    });
    app = buildServer({ authStore: store });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    __resetTenantStoreForTests();
  });

  it("POST /tenants creates tenant, switches session, returns me", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    const token = loginRes.json().token as string;

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tenants",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Fresh org" }
    });
    expect(create.statusCode).toBe(200);
    const me = create.json();
    expect(me.role).toBe("owner");
    expect(me.memberships.length).toBe(5);
    const createdId = me.tenantId;
    expect(createdId.startsWith("t-")).toBe(true);
    expect(me.memberships.some((m: { tenantId: string }) => m.tenantId === createdId)).toBe(true);

    const meGet = await app.inject({
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(meGet.json().tenantId).toBe(createdId);
  });

  it("POST /tenants returns 409 when tenantId is taken", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    const token = loginRes.json().token as string;

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/tenants",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "A", tenantId: "t-custom-slug" }
    });
    expect(first.statusCode).toBe(200);

    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/tenants",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "B", tenantId: "t-custom-slug" }
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("TENANT_ID_TAKEN");
  });

  it("DELETE tenant reassigns session when another membership exists", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    const token = loginRes.json().token as string;

    await app.inject({
      method: "POST",
      url: "/api/v1/session/active-tenant",
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantId: "t-2" }
    });

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/tenants/t-2",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.statusCode).toBe(204);

    const me = await app.inject({
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(me.statusCode).toBe(200);
    const j = me.json();
    expect(j.memberships.some((m: { tenantId: string }) => m.tenantId === "t-2")).toBe(false);
    expect(j.tenantId).toBe("t-1");
  });

  it("DELETE returns 403 for viewer membership on that tenant", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    const token = loginRes.json().token as string;

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/tenants/t-3",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.statusCode).toBe(403);
  });

  it("DELETE returns 403 for operator membership on that tenant", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    const token = loginRes.json().token as string;

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/tenants/t-4",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.statusCode).toBe(403);
  });

  it("DELETE returns 409 for default webhook tenant id when configured", async () => {
    const prev = process.env.SM_DEFAULT_TENANT_ID;
    process.env.SM_DEFAULT_TENANT_ID = "t-1";

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    const token = loginRes.json().token as string;

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/tenants/t-1",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe("PROTECTED_TENANT");

    process.env.SM_DEFAULT_TENANT_ID = prev;
  });
});
