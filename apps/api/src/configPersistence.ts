import fs from "node:fs";
import path from "node:path";

export type KaiadConfig = {
  setupComplete: boolean;
  databaseUrl?: string;
  redisUrl?: string;
  publicBaseUrl?: string;
  internalApiToken?: string;
  internalApiUrl?: string;
  defaultWebhookTenantId?: string;
  githubApp?: {
    appId?: string;
    privateKeyPem?: string;
    webhookSecret?: string;
  };
  oauth?: {
    googleClientId?: string;
    googleClientSecret?: string;
  };
  kubernetes?: {
    namespace?: string;
    [key: string]: string | undefined;
  };
};

const CONFIG_FILENAME = "kaiad.config.json";
const DEFAULT_DATA_DIR = "./data";

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KAIAD_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(resolveDataDir(env), CONFIG_FILENAME);
}

export function loadKaiadConfig(env: NodeJS.ProcessEnv = process.env): KaiadConfig | null {
  const configPath = resolveConfigPath(env);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as KaiadConfig;
  if (typeof parsed.setupComplete !== "boolean") {
    parsed.setupComplete = false;
  }
  return parsed;
}

function setEnvIfMissing(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (!value?.trim()) {
    return;
  }
  if (!env[key]?.trim()) {
    env[key] = value;
  }
}

export function applyKaiadConfigToEnv(config: KaiadConfig, env: NodeJS.ProcessEnv = process.env): void {
  setEnvIfMissing(env, "DATABASE_URL", config.databaseUrl);
  setEnvIfMissing(env, "REDIS_URL", config.redisUrl);
  setEnvIfMissing(env, "PUBLIC_BASE_URL", config.publicBaseUrl);
  setEnvIfMissing(env, "INTERNAL_API_TOKEN", config.internalApiToken);
  setEnvIfMissing(env, "INTERNAL_API_URL", config.internalApiUrl);
  setEnvIfMissing(env, "DEFAULT_WEBHOOK_TENANT_ID", config.defaultWebhookTenantId);
  setEnvIfMissing(env, "GITHUB_APP_ID", config.githubApp?.appId);
  setEnvIfMissing(env, "GITHUB_APP_PRIVATE_KEY", config.githubApp?.privateKeyPem);
  setEnvIfMissing(env, "GITHUB_WEBHOOK_SECRET", config.githubApp?.webhookSecret);
  setEnvIfMissing(env, "GOOGLE_CLIENT_ID", config.oauth?.googleClientId);
  setEnvIfMissing(env, "GOOGLE_CLIENT_SECRET", config.oauth?.googleClientSecret);
  setEnvIfMissing(env, "KAIAD_K8S_NAMESPACE", config.kubernetes?.namespace);
}

export function bootstrapEnv(env: NodeJS.ProcessEnv = process.env): KaiadConfig | null {
  const config = loadKaiadConfig(env);
  if (config) {
    applyKaiadConfigToEnv(config, env);
  }
  return config;
}

export function resolveSetupState(env: NodeJS.ProcessEnv = process.env): {
  setupRequired: boolean;
  setupComplete: boolean;
} {
  if (env.NODE_ENV === "test" && env.KAIAD_SETUP_REQUIRED !== "1") {
    return { setupRequired: false, setupComplete: false };
  }
  const setupComplete = env.KAIAD_SETUP_COMPLETE === "1";
  const hasDatabase = Boolean(env.DATABASE_URL?.trim());
  const setupRequired = !hasDatabase && !setupComplete;
  return { setupRequired, setupComplete };
}

export function writeKaiadConfig(config: KaiadConfig, env: NodeJS.ProcessEnv = process.env): string {
  const configPath = resolveConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return configPath;
}
