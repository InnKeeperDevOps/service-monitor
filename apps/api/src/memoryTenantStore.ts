import type { TenantSettings } from "@sm/contracts";

const settingsByTenant = new Map<string, TenantSettings>();

export type TenantStore = {
  getTenantSettings(tenantId: string): Promise<TenantSettings | undefined>;
  upsertTenantSettings(settings: TenantSettings): Promise<TenantSettings>;
};

export function createMemoryTenantStore(): TenantStore {
  return {
    async getTenantSettings(tenantId: string) {
      return settingsByTenant.get(tenantId);
    },
    async upsertTenantSettings(settings: TenantSettings) {
      settingsByTenant.set(settings.tenantId, settings);
      return settings;
    }
  };
}

/** Test helper: reset maps (same process as tests) */
export function __resetMemoryTenantStoreForTests(): void {
  settingsByTenant.clear();
}
