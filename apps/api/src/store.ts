import { ensureCoreSchema } from "@sm/db";
import { createMemoryTenantStore, __resetMemoryTenantStoreForTests, type TenantStore } from "./memoryTenantStore.js";
import { createPostgresTenantStore } from "./postgresTenantStore.js";
import { resolveTenantStoreBackend } from "./storeAdapter.js";
import type { GithubInstallationSettings, TenantSettings } from "@sm/contracts";

let storePromise: Promise<TenantStore> | null = null;

async function pgImportAvailable(): Promise<boolean> {
  try {
    await import("pg");
    return true;
  } catch {
    return false;
  }
}

async function initStore(): Promise<TenantStore> {
  const pgOk = await pgImportAvailable();
  const backend = resolveTenantStoreBackend(process.env, pgOk);
  if (backend === "postgres") {
    const { Pool } = await import("pg");
    const url = process.env.DATABASE_URL;
    if (!url?.trim()) {
      return createMemoryTenantStore();
    }
    const pool = new Pool({ connectionString: url });
    await ensureCoreSchema(pool);
    return createPostgresTenantStore(pool);
  }
  return createMemoryTenantStore();
}

async function getStore(): Promise<TenantStore> {
  if (!storePromise) {
    storePromise = initStore();
  }
  return storePromise;
}

export async function getTenantSettings(tenantId: string): Promise<TenantSettings | undefined> {
  return (await getStore()).getTenantSettings(tenantId);
}

export async function upsertTenantSettings(settings: TenantSettings): Promise<TenantSettings> {
  return (await getStore()).upsertTenantSettings(settings);
}

export async function listGithubInstallationsForTenant(tenantId: string): Promise<GithubInstallationSettings[]> {
  return (await getStore()).listGithubInstallationsForTenant(tenantId);
}

export async function upsertGithubInstallationForTenant(
  tenantId: string,
  installation: GithubInstallationSettings
): Promise<GithubInstallationSettings> {
  return (await getStore()).upsertGithubInstallationForTenant(tenantId, installation);
}

/** Test helper: reset backend selection and in-memory tenant data */
export function __resetTenantStoreForTests(): void {
  storePromise = null;
  __resetMemoryTenantStoreForTests();
}
