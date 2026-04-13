import type { TenantSettings } from "@sm/contracts";

export type TenantSettingsPatch = Partial<{
  docsUrl: string | null;
  preferredExecutor: "cursor" | "claude" | null;
}>;

export function mergeTenantSettings(base: TenantSettings, patch: TenantSettingsPatch): TenantSettings {
  const out: TenantSettings = {
    tenantId: base.tenantId
  };

  const docsUrl = patch.docsUrl !== undefined ? patch.docsUrl : base.docsUrl;
  if (docsUrl != null) out.docsUrl = docsUrl;

  const preferredExecutor = patch.preferredExecutor !== undefined ? patch.preferredExecutor : base.preferredExecutor;
  if (preferredExecutor != null) out.preferredExecutor = preferredExecutor;

  return out;
}
