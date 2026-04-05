import fs from "node:fs";
import path from "node:path";
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
  const dataDir = getDataDir();
  const configPath = path.join(dataDir, "kaiad.config.json");

  let config: KaiadConfig;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    config = JSON.parse(raw) as KaiadConfig;
  } catch {
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

export function isSetupRequired(): boolean {
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  if (hasDatabaseUrl) return false;

  const dataDir = getDataDir();
  const configPath = path.join(dataDir, "kaiad.config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as KaiadConfig;
    if (config.setupComplete && config.databaseUrl) return false;
  } catch {
    // No config file — setup is required
  }
  return true;
}
