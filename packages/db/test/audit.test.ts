import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { writeAuditLog, listAuditLogs, type QueryFn } from "../src/audit.js";

vi.stubGlobal("crypto", crypto);

function mockQuery(rows: Record<string, unknown>[] = []): QueryFn {
  return vi.fn().mockResolvedValue({ rows });
}

describe("writeAuditLog", () => {
  it("calls INSERT with correct params and returns the generated id", async () => {
    const query = mockQuery();
    const id = await writeAuditLog(query, {
      tenantId: "t-1",
      actorId: "u-1",
      action: "service.create",
      targetType: "service",
      targetId: "svc-1",
      metadata: { repo: "acme/app" }
    });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(query).toHaveBeenCalledOnce();

    const [sql, params] = (query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("INSERT INTO audit_logs");
    expect(params[0]).toBe(id);
    expect(params[1]).toBe("t-1");
    expect(params[2]).toBe("u-1");
    expect(params[3]).toBe("service.create");
    expect(params[4]).toBe("service");
    expect(params[5]).toBe("svc-1");
    expect(JSON.parse(params[6])).toEqual({ repo: "acme/app" });
  });

  it("defaults actorId and targetId to null, metadata to empty object", async () => {
    const query = mockQuery();
    await writeAuditLog(query, {
      tenantId: "t-1",
      action: "tenant.login",
      targetType: "session"
    });

    const [, params] = (query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(params[2]).toBeNull();
    expect(params[5]).toBeNull();
    expect(JSON.parse(params[6])).toEqual({});
  });
});

describe("listAuditLogs", () => {
  it("maps rows correctly with string metadata_json", async () => {
    const query = mockQuery([
      {
        tenant_id: "t-1",
        actor_id: "u-1",
        action: "service.create",
        target_type: "service",
        target_id: "svc-1",
        metadata_json: JSON.stringify({ repo: "acme/app" })
      }
    ]);

    const results = await listAuditLogs(query, "t-1");
    expect(results).toEqual([
      {
        tenantId: "t-1",
        actorId: "u-1",
        action: "service.create",
        targetType: "service",
        targetId: "svc-1",
        metadata: { repo: "acme/app" }
      }
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM audit_logs"),
      ["t-1", 50]
    );
  });

  it("handles object metadata_json (pre-parsed by driver)", async () => {
    const query = mockQuery([
      {
        tenant_id: "t-2",
        actor_id: null,
        action: "agent.enroll",
        target_type: "agent",
        target_id: null,
        metadata_json: { token: "abc" }
      }
    ]);

    const results = await listAuditLogs(query, "t-2", 10);
    expect(results).toEqual([
      {
        tenantId: "t-2",
        actorId: undefined,
        action: "agent.enroll",
        targetType: "agent",
        targetId: undefined,
        metadata: { token: "abc" }
      }
    ]);
    expect(query).toHaveBeenCalledWith(expect.any(String), ["t-2", 10]);
  });
});
