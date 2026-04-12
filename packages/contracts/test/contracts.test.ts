import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentToPlatformMessageSchema,
  apiErrorSchema,
  createEnrollmentTokenResponseSchema,
  listSshKeysResponseSchema,
  createSshKeyRequestSchema,
  healthResponseSchema,
  listEnrollmentTokensResponseSchema,
  remediationJobSchema,
  tenantSettingsSchema
} from "../src/index.js";

describe("contracts", () => {
  it("validates api error envelope", () => {
    const parsed = apiErrorSchema.parse({
      code: "POLICY_DENY",
      message: "Denied",
      correlationId: "cid-1"
    });
    expect(parsed.code).toBe("POLICY_DENY");
  });

  it("parses SSH Key contracts", () => {
    const body = createSshKeyRequestSchema.parse({
      name: "My Key",
      type: "uploaded",
      privateKey: "secret"
    });
    expect(body.name).toBe("My Key");
    const list = listSshKeysResponseSchema.parse({
      keys: [{ id: "1", tenantId: "t-1", name: "My Key", type: "uploaded", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]
    });
    expect(list.keys).toHaveLength(1);
  });

  it("parses tenant settings without automation policy (backward compatible)", () => {
    const parsed = tenantSettingsSchema.parse({
      tenantId: "t-1"
    });
    expect(parsed.automationPolicy).toBeUndefined();
  });

  it("validates health response schema", () => {
    expect(
      healthResponseSchema.parse({
        status: "ok",
        uptimeSeconds: 10
      })
    ).toBeTruthy();
  });

  it("rejects invalid remediation jobs", () => {
    const result = remediationJobSchema.safeParse({
      tenantId: "t1"
    });
    expect(result.success).toBe(false);
  });

  it("parses enrollment token create/list responses", () => {
    const created = createEnrollmentTokenResponseSchema.parse({
      id: "tok-1",
      tenantId: "t-1",
      token: "plaintext-secret",
      expiresAt: "2026-01-01T00:00:00.000Z",
      createdBy: "u-1",
      createdAt: "2025-12-31T00:00:00.000Z",
      usedAt: null,
      revokedAt: null,
      isActive: true
    });
    expect(created.token).toBe("plaintext-secret");

    const listed = listEnrollmentTokensResponseSchema.parse({
      tokens: [
        {
          id: "tok-1",
          tenantId: "t-1",
          expiresAt: "2026-01-01T00:00:00.000Z",
          createdBy: "u-1",
          createdAt: "2025-12-31T00:00:00.000Z",
          usedAt: null,
          revokedAt: null,
          isActive: true
        }
      ]
    });
    expect(listed.tokens[0]).not.toHaveProperty("token");
  });

  it("parses heartbeat fixture", async () => {
    const fixturePath = resolve(import.meta.dirname, "../fixtures/agent-heartbeat.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(agentToPlatformMessageSchema.parse(fixture).type).toBe("heartbeat");
  });
});
