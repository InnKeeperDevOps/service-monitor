import path from "node:path";
import { readConfig } from "./configPersistence.js";
import type { KaiadConfig } from "./configPersistence.js";

const CONFIG_KEY_MAP: Record<string, string> = {
  databaseUrl: "DATABASE_URL",
  redisUrl: "REDIS_URL",
  publicBaseUrl: "PUBLIC_BASE_URL",
  internalApiToken: "INTERNAL_API_TOKEN",
  internalApiUrl: "INTERNAL_API_URL",
  defaultWebhookTenantId: "DEFAULT_WEBHOOK_TENANT_ID",
};

const NESTED_KEY_MAP: Record<string, Record<string, string>> = {
  githubApp: {
    appId: "GITHUB_APP_ID",
    privateKeyPem: "GITHUB_APP_PRIVATE_KEY",
    webhookSecret: "GITHUB_WEBHOOK_SECRET",
  },
  oauth: {
    googleClientId: "GOOGLE_CLIENT_ID",
    googleClientSecret: "GOOGLE_CLIENT_SECRET",
  },
  kubernetes: {
    namespace: "KAIAD_K8S_NAMESPACE",
  },
};

export function getDataDir(): string {
  return path.resolve(process.env.KAIAD_DATA_DIR || "./data");
}

export function bootstrapEnv(): { setupComplete: boolean; configLoaded: boolean } {
  const config = readConfig();
  if (!config) {
    return { setupComplete: false, configLoaded: false };
  }

  for (const [jsonKey, envKey] of Object.entries(CONFIG_KEY_MAP)) {
    const value = config[jsonKey as keyof KaiadConfig];
    if (typeof value === "string") {
      process.env[envKey] = value;
    }
  }

  for (const [section, mapping] of Object.entries(NESTED_KEY_MAP)) {
    const nested = config[section as keyof KaiadConfig];
    if (nested && typeof nested === "object") {
      for (const [nestedKey, envKey] of Object.entries(mapping)) {
        const value = (nested as Record<string, unknown>)[nestedKey];
        if (typeof value === "string") {
          process.env[envKey] = value;
        }
      }
    }
  }

  return { setupComplete: config.setupComplete ?? false, configLoaded: true };
}

/**
 * Apply GitHub App credentials to `process.env` (runtime hot-reload).
 * Long-lived workers may need a full process restart to pick up changes.
 */
export function applyGithubAppToEnv(githubApp: NonNullable<KaiadConfig["githubApp"]>): void {
  process.env.GITHUB_APP_ID = githubApp.appId;
  process.env.GITHUB_APP_PRIVATE_KEY = githubApp.privateKeyPem;
  process.env.GITHUB_WEBHOOK_SECRET = githubApp.webhookSecret;
}

export function isSetupRequired(): boolean {
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  if (hasDatabaseUrl) return false;
  const config = readConfig();
  if (config?.setupComplete && config.databaseUrl) return false;
  return true;
}
