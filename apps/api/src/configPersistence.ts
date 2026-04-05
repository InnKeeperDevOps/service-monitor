import fs from "node:fs";
import path from "node:path";

export type KaiadConfig = {
  setupComplete: boolean;
  databaseUrl?: string;
  redisUrl?: string;
  publicBaseUrl?: string;
  internalApiToken?: string;
  internalApiUrl?: string;
  githubApp?: {
    appId: string;
    privateKeyPem: string;
    webhookSecret: string;
  };
  oauth?: {
    googleClientId?: string;
    googleClientSecret?: string;
  };
  defaultWebhookTenantId?: string;
  kubernetes?: {
    namespace?: string;
  };
  port?: number;
};

function getConfigPath(): string {
  const dataDir = process.env.KAIAD_DATA_DIR || "./data";
  return path.resolve(dataDir, "kaiad.config.json");
}

export function readConfig(): KaiadConfig | null {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as KaiadConfig;
  } catch {
    return null;
  }
}

export async function writeConfig(config: KaiadConfig): Promise<void> {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  fs.chmodSync(configPath, 0o600);
}
