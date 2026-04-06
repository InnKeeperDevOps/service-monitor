import type { TenantSettings } from "@sm/contracts";
import { describe, expect, it } from "vitest";
import { mergeTenantSettingsPayload } from "../src/features/settings/mergeTenantSettings.js";

describe("mergeTenantSettingsPayload", () => {
  const sessionTenantId = "t-1";

  it("fills required fields from patch when no previous row", () => {
    const merged = mergeTenantSettingsPayload(sessionTenantId, null, {
      githubRepo: "o/r",
      defaultBranch: "main"
    });
    expect(merged).toEqual({
      tenantId: sessionTenantId,
      githubRepo: "o/r",
      defaultBranch: "main"
    });
  });

  it("merges automationPolicy kill-switch into existing settings", () => {
    const previous: TenantSettings = {
      tenantId: sessionTenantId,
      githubRepo: "acme/app",
      defaultBranch: "develop",
      automationPolicy: {
        repos: ["acme/app"],
        branches: ["main"],
        actions: ["create_pr", "merge_pr"]
      }
    };
    const merged = mergeTenantSettingsPayload(sessionTenantId, previous, {
      automationPolicy: { repos: [], branches: [], actions: [] }
    });
    expect(merged.githubRepo).toBe("acme/app");
    expect(merged.defaultBranch).toBe("develop");
    expect(merged.automationPolicy).toEqual({ repos: [], branches: [], actions: [] });
  });

  it("clears optional docsUrl when patch sets null", () => {
    const previous: TenantSettings = {
      tenantId: sessionTenantId,
      githubRepo: "o/r",
      defaultBranch: "main",
      docsUrl: "https://docs.example.com"
    };
    const merged = mergeTenantSettingsPayload(sessionTenantId, previous, { docsUrl: null });
    expect(merged.docsUrl).toBeUndefined();
  });
});
