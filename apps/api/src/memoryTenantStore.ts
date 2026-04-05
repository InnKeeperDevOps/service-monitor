import type { GithubInstallationSettings, TenantSettings } from "@sm/contracts";

const settingsByTenant = new Map<string, TenantSettings>();
const githubInstallationByTenant = new Map<string, GithubInstallationSettings>();

export type TenantStore = {
  getTenantSettings(tenantId: string): Promise<TenantSettings | undefined>;
  upsertTenantSettings(settings: TenantSettings): Promise<TenantSettings>;
  listGithubInstallationsForTenant(tenantId: string): Promise<GithubInstallationSettings[]>;
  upsertGithubInstallationForTenant(
    tenantId: string,
    installation: GithubInstallationSettings
  ): Promise<GithubInstallationSettings>;
};

export function createMemoryTenantStore(): TenantStore {
  return {
    async getTenantSettings(tenantId: string) {
      return settingsByTenant.get(tenantId);
    },
    async upsertTenantSettings(settings: TenantSettings) {
      settingsByTenant.set(settings.tenantId, settings);
      return settings;
    },
    async listGithubInstallationsForTenant(tenantId: string) {
      const row = githubInstallationByTenant.get(tenantId);
      return row ? [row] : [];
    },
    async upsertGithubInstallationForTenant(tenantId: string, installation: GithubInstallationSettings) {
      githubInstallationByTenant.set(tenantId, installation);
      return installation;
    }
  };
}

/** Test helper: reset maps (same process as tests) */
export function __resetMemoryTenantStoreForTests(): void {
  settingsByTenant.clear();
  githubInstallationByTenant.clear();
}
