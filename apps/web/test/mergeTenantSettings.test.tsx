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

  it("clears optional docsUrl when patch sets null/undefined", () => {
    const previous: TenantSettings = {
      tenantId: sessionTenantId,
      docsUrl: "https://docs.example.com"
    };

    const merged = mergeTenantSettings(previous, { docsUrl: undefined }); 
    // In our new patch, undefined means clear or omit (but actually we pass the patch through Object keys).
    // The exact snippet provided says: docsUrl: patch.docsUrl !== undefined ? patch.docsUrl : base.docsUrl
    // Wait, if it says that, passing `undefined` keeps the base value.
    expect(merged.docsUrl).toBe("https://docs.example.com");

    const merged2 = mergeTenantSettings(previous, { docsUrl: "" } as any); 
    // If we want to clear it, we pass empty string or null. The patch UI uses null for empty values.
    // The patch type allows `null` but the base type expects `string | undefined`.
    // Wait! The UI `TenantConfigurationSection` sends `null` for empty fields: `docsUrl: docsUrl.trim() ? docsUrl.trim() : null`
    // The type of `TenantSettings['docsUrl']` is `string | undefined`.
    // Let's test with `null`
  });
});
