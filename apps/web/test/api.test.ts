import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, meResponseToAuthUser } from "../src/lib/api.js";

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

    await api.createWorkflow({ serviceId: "svc-1", nodes: [], edges: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3001/api/v1/workflows");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({ serviceId: "svc-1", nodes: [], edges: [] })
      })
    );
  });
});
