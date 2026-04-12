import type { TenantSettings } from "@sm/contracts";

export type TenantSettingsPatch = Partial<{
  docsUrl: string | null;
  preferredExecutor: "cursor" | "claude" | null;
  agentRuntimeBackend: "docker" | "kubernetes" | "shell" | null;
  automationPolicy: TenantSettings["automationPolicy"] | null;
}>;

export function mergeTenantSettings(base: TenantSettings, patch: TenantSettingsPatch): TenantSettings {
  const out: TenantSettings = {
    tenantId: base.tenantId
  };

  const docsUrl = patch.docsUrl !== undefined ? patch.docsUrl : base.docsUrl;
  if (docsUrl != null) out.docsUrl = docsUrl;

  const automationPolicy = patch.automationPolicy !== undefined ? patch.automationPolicy : base.automationPolicy;
  if (automationPolicy != null) out.automationPolicy = automationPolicy;

  const preferredExecutor = patch.preferredExecutor !== undefined ? patch.preferredExecutor : base.preferredExecutor;
  if (preferredExecutor != null) out.preferredExecutor = preferredExecutor;

  const agentRuntimeBackend = patch.agentRuntimeBackend !== undefined ? patch.agentRuntimeBackend : base.agentRuntimeBackend;
  if (agentRuntimeBackend != null) out.agentRuntimeBackend = agentRuntimeBackend;

  return out;
}
