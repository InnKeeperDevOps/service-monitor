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
    /** Public URL segment for https://github.com/apps/<slug>/installations/new */
    appSlug?: string;
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

export function getConfigPath(): string {
  const dataDir = process.env.KAIAD_DATA_DIR || "./data";
  return path.resolve(dataDir, "kaiad.config.json");
}

export function readConfig(): KaiadConfig | null {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as KaiadConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[config] Failed to read ${configPath}: ${message}`);
    }
    return null;
  }
}

export async function writeConfig(config: KaiadConfig): Promise<void> {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, configPath);
}
