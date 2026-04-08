import type { TenantSettings } from "@sm/contracts";

/** Partial update: use `null` on optional fields to clear them. */
export type TenantSettingsPatch = Partial<{
  githubRepo: string;
  defaultBranch: string;
  docsUrl: string | null;
  preferredExecutor: "cursor" | "claude" | null;
  agentRuntimeBackend: "docker" | "kubernetes" | "shell" | null;
  agentWorkloadSource: "github_repo" | "binary" | null;
  automationPolicy: TenantSettings["automationPolicy"] | null;
}>;

/**
 * Builds a full `TenantSettings` for POST /api/v1/settings (server replaces the whole document).
 * `previous` is the last loaded row; `patch` contains only fields to change.
 */
export function mergeTenantSettingsPayload(
  sessionTenantId: string,
  previous: TenantSettings | null,
  patch: TenantSettingsPatch
): TenantSettings {
  const base: TenantSettings = previous ?? {
    tenantId: sessionTenantId,
    githubRepo: "",
    defaultBranch: ""
  };

  const out: TenantSettings = {
    tenantId: sessionTenantId,
    githubRepo: patch.githubRepo !== undefined ? patch.githubRepo : base.githubRepo,
    defaultBranch: patch.defaultBranch !== undefined ? patch.defaultBranch : base.defaultBranch
  };

  if ("docsUrl" in patch) {
    if (patch.docsUrl === null || patch.docsUrl === "") {
      /* omit optional */
    } else {
      out.docsUrl = patch.docsUrl;
    }
  } else if (base.docsUrl !== undefined) {
    out.docsUrl = base.docsUrl;
  }

  if ("automationPolicy" in patch) {
    if (patch.automationPolicy === null) {
      /* omit */
    } else if (patch.automationPolicy) {
      out.automationPolicy = patch.automationPolicy;
    }
  } else if (base.automationPolicy !== undefined) {
    out.automationPolicy = base.automationPolicy;
  }

  if ("preferredExecutor" in patch) {
    if (patch.preferredExecutor === null) {
      /* omit */
    } else if (patch.preferredExecutor) {
      out.preferredExecutor = patch.preferredExecutor;
    }
  } else if (base.preferredExecutor !== undefined) {
    out.preferredExecutor = base.preferredExecutor;
  }

  if ("agentRuntimeBackend" in patch) {
    if (patch.agentRuntimeBackend === null) {
      /* omit */
    } else if (patch.agentRuntimeBackend) {
      out.agentRuntimeBackend = patch.agentRuntimeBackend;
    }
  } else if (base.agentRuntimeBackend !== undefined) {
    out.agentRuntimeBackend = base.agentRuntimeBackend;
  }

  if ("agentWorkloadSource" in patch) {
    if (patch.agentWorkloadSource === null) {
      out.agentWorkloadSource = null;
    } else if (patch.agentWorkloadSource) {
      out.agentWorkloadSource = patch.agentWorkloadSource;
    }
  } else if (base.agentWorkloadSource !== undefined) {
    out.agentWorkloadSource = base.agentWorkloadSource;
  }

  return out;
}
