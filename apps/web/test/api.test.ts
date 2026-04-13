import type { MeResponse } from "@sm/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, meResponseToAuthUser, getTenantSettings } from "../src/lib/api.js";

describe("api lib", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("maps /me response to auth user shape", () => {
    const authUser = meResponseToAuthUser({
      id: "u-1",
      email: "u@example.com",
      role: "admin",
      tenantId: "t-1",
      memberships: [{ tenantId: "t-1", tenantName: "Acme", role: "owner" }]
    });

    expect(authUser).toEqual({
      id: "u-1",
      email: "u@example.com",
      role: "admin",
      tenantId: "t-1",
      memberships: [{ tenantId: "t-1", tenantName: "Acme", role: "owner" }]
    });
  });

  it("synthesizes a single membership from active tenant when memberships is empty", () => {
    const authUser = meResponseToAuthUser({
      id: "u-1",
      email: "u@example.com",
      role: "admin",
      tenantId: "t-1",
      memberships: []
    });

    expect(authUser.memberships).toEqual([
      { tenantId: "t-1", tenantName: "t-1", role: "admin" }
    ]);
  });

  it("synthesizes membership when /me omits memberships", () => {
    const authUser = meResponseToAuthUser({
      id: "u-1",
      email: "u@example.com",
      role: "viewer",
      tenantId: "t-solo"
    } as MeResponse);

    expect(authUser.memberships).toEqual([
      { tenantId: "t-solo", tenantName: "t-solo", role: "viewer" }
    ]);
  });

  it("ignores non-array memberships and falls back to active tenant", () => {
    const authUser = meResponseToAuthUser({
      id: "u-1",
      email: "u@example.com",
      role: "operator",
      tenantId: "t-1",
      memberships: "invalid" as unknown as []
    } as MeResponse);

    expect(authUser.memberships).toEqual([
      { tenantId: "t-1", tenantName: "t-1", role: "operator" }
    ]);
  });

  it("sends bearer token and json body for workflow create", async () => {
    localStorage.setItem("sm_token", "test-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "wf-1",
        tenantId: "t-1",
        serviceId: "svc-1",
        version: 1,
        nodes: [],
        edges: [],
        isActive: false
      })
    } as Response);

    // Mock original test
    await api.createWorkflow({ name: "test", nodes: [], edges: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3001/api/v1/workflows");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({ name: "test", nodes: [], edges: [] })
      })
    );
  });

  it("getTenantSettings returns null on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 404,
      ok: false
    } as Response);
    
    const res = await getTenantSettings();
    expect(res).toBeNull();
  });

  it("getTenantSettings throws on error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 500,
      ok: false,
      statusText: "Server Error",
      json: async () => ({ message: "Failed" })
    } as Response);
    
    await expect(getTenantSettings()).rejects.toThrow("Failed");
  });

  it("apiFetch throws on non-ok responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 403,
      ok: false,
      statusText: "Forbidden",
      json: async () => { throw new Error("parse error") }
    } as Response);
    
    await expect(api.me()).rejects.toThrow("Forbidden");
  });

  it("apiFetch handles 204 No Content correctly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 204,
      ok: true
    } as Response);
    
    const res = await api.deleteTenant("t1");
    expect(res).toBeUndefined();
  });

  it("logout removes token and reloads window", () => {
    localStorage.setItem("sm_token", "test");
    
    // Create a mock for window.location.reload
    const originalLocation = window.location;
    delete (window as any).location;
    window.location = { ...originalLocation, reload: vi.fn() } as any;

    api.logout();

    expect(localStorage.getItem("sm_token")).toBeNull();
    expect(window.location.reload).toHaveBeenCalled();

    // Restore
    window.location = originalLocation;
  });

  describe("API endpoints coverage", () => {
    let fetchMock: any;
    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true })
      } as Response);
    });

    it("covers standard API methods", async () => {
      await api.login("user", "pass");
      await api.switchActiveTenant("t2");
      await api.createTenant({ name: "Tenant2" });
      await api.listSshKeys();
      await api.createSshKey({ name: "key1", privateKeyPem: "pem" });
      await api.deleteSshKey("key1");
      await api.listIncidents();
      await api.updateIncidentStatus("inc1", "resolved");
      await api.listAgents();
      await api.listServices();
      await api.createService({ name: "svc1", gitRepoUrl: "url", branch: "main" });
      await api.updateService("svc1", { name: "svc1-new" });
      await api.executeWorkflow({ name: "wf", serviceId: "svc1", nodes: [], edges: [] });
      await api.dryRunWorkflow({ name: "wf", serviceId: "svc1", nodes: [], edges: [] });
      await api.listWorkflows();
      await api.setServiceWorkflow("svc1", "wf1");
      await api.getSettings();
      await api.updateSettings({ tenantId: "t1" });
      await api.listEnrollmentTokens();
      await api.createEnrollmentToken({ ttlSeconds: 3600 });
      await api.deactivateEnrollmentToken("tok1");
      await api.deleteEnrollmentToken("tok1");
      await api.listGithubInstallations();
      await api.syncGithubInstallation(123);
      await api.listGithubInstallationRepos();
      await api.getAuthProviders();
      await api.createOAuthProvider({ id: "1", provider: "g", clientId: "c", clientSecret: "s", authorizeUrl: "a", tokenUrl: "t", userInfoUrl: "u", scopes: [] });
      await api.getGithubAppSettings();
      await api.updateGithubAppSettings({ githubAppId: "app1" });
      await api.getOAuthAuthorizeUrl("google");
      await api.handleOAuthCallback("code123", "state123");
      await api.getSetupStatus();
      await api.testDatabase("postgres://");
      await api.testRedis("redis://");
      await api.getSetupTenants("postgres://");
      await api.completeSetup({ databaseUrl: "db", redisUrl: "rd", adminEmail: "a", adminPassword: "p" });
      
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});
