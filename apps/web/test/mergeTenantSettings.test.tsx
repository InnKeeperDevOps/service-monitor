import type { TenantSettings } from "@sm/contracts";
import { describe, expect, it } from "vitest";
import { mergeTenantSettings } from "../src/features/settings/mergeTenantSettings.js";

describe("mergeTenantSettings", () => {
  const sessionTenantId = "t-1";

  it("fills required fields from patch when no previous row", () => {
    const base: TenantSettings = { tenantId: sessionTenantId };
    const merged = mergeTenantSettings(base, {
      docsUrl: "https://docs.example.com"
    });
    expect(merged).toEqual({
      tenantId: sessionTenantId,
      docsUrl: "https://docs.example.com"
    });
  });

  it("merges automationPolicy kill-switch into existing settings", () => {
    const previous: TenantSettings = {
      tenantId: sessionTenantId,
      automationPolicy: {
        repos: ["acme/app"],
        branches: ["main"],
        actions: ["create_pr", "merge_pr"]
      }
    };
    
    const merged = mergeTenantSettings(previous, {
      automationPolicy: { repos: [], branches: [], actions: [] }
    });
    expect(merged.automationPolicy).toEqual({ repos: [], branches: [], actions: [] });
  });

  it("clears optional fields when patch sets null", () => {
    const previous: TenantSettings = {
      tenantId: sessionTenantId,
      docsUrl: "https://docs.example.com",
      preferredExecutor: "claude",
      agentRuntimeBackend: "shell",
      automationPolicy: {
        repos: ["acme/app"],
        branches: ["main"],
        actions: ["create_pr", "merge_pr"]
      }
    };

    const merged = mergeTenantSettings(previous, { 
      docsUrl: null,
      preferredExecutor: null,
      agentRuntimeBackend: null,
      automationPolicy: null
    }); 
    
    expect(merged.docsUrl).toBeUndefined();
    expect(merged.preferredExecutor).toBeUndefined();
    expect(merged.agentRuntimeBackend).toBeUndefined();
    expect(merged.automationPolicy).toBeUndefined();
  });
});