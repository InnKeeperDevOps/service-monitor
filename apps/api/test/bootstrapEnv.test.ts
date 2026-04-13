import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapEnv, applyGithubAppToEnv, isSetupRequired } from "../src/bootstrapEnv.js";

describe("bootstrapEnv", () => {
  let tempDataDir: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempDataDir) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
      tempDataDir = null;
    }
  });

  it("returns configLoaded false if no config", () => {
    vi.stubEnv("KAIAD_DATA_DIR", "/non/existent/dir");
    const result = bootstrapEnv();
    expect(result).toEqual({ setupComplete: false, configLoaded: false });
  });

  it("loads nested config values into process env", () => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaiad-config-"));
    fs.writeFileSync(
      path.join(tempDataDir, "kaiad.config.json"),
      JSON.stringify(
        {
          setupComplete: true,
          githubApp: { appId: "gh-id", privateKeyPem: "pem", webhookSecret: "secret", appSlug: "slug" },
          oauth: { googleClientId: "google-id" },
          kubernetes: { namespace: "my-ns" }
        },
        null,
        2
      )
    );
    vi.stubEnv("KAIAD_DATA_DIR", tempDataDir);
    bootstrapEnv();
    expect(process.env.GITHUB_APP_ID).toBe("gh-id");
    expect(process.env.GITHUB_APP_PRIVATE_KEY).toBe("pem");
    expect(process.env.GITHUB_WEBHOOK_SECRET).toBe("secret");
    expect(process.env.GITHUB_APP_SLUG).toBe("slug");
    expect(process.env.GOOGLE_CLIENT_ID).toBe("google-id");
    expect(process.env.KAIAD_K8S_NAMESPACE).toBe("my-ns");
  });

  describe("applyGithubAppToEnv", () => {
    it("applies github app config to process env", () => {
      applyGithubAppToEnv({ appId: "id2", privateKeyPem: "pem2", webhookSecret: "secret2", appSlug: "slug2" });
      expect(process.env.GITHUB_APP_ID).toBe("id2");
      expect(process.env.GITHUB_APP_PRIVATE_KEY).toBe("pem2");
      expect(process.env.GITHUB_WEBHOOK_SECRET).toBe("secret2");
      expect(process.env.GITHUB_APP_SLUG).toBe("slug2");
    });
  });

  describe("isSetupRequired", () => {
    it("returns false if DATABASE_URL is set", () => {
      vi.stubEnv("DATABASE_URL", "postgres://test");
      expect(isSetupRequired()).toBe(false);
    });

    it("returns false if setupComplete and databaseUrl are in config", () => {
      tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaiad-config-"));
      fs.writeFileSync(
        path.join(tempDataDir, "kaiad.config.json"),
        JSON.stringify({ setupComplete: true, databaseUrl: "postgres://config" })
      );
      vi.stubEnv("KAIAD_DATA_DIR", tempDataDir);
      vi.stubEnv("DATABASE_URL", "");
      expect(isSetupRequired()).toBe(false);
    });

    it("returns true otherwise", () => {
      vi.stubEnv("KAIAD_DATA_DIR", "/non/existent");
      vi.stubEnv("DATABASE_URL", "");
      expect(isSetupRequired()).toBe(true);
    });
  });

  it("loads setup config values into process env", () => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaiad-config-"));
    fs.writeFileSync(
      path.join(tempDataDir, "kaiad.config.json"),
      JSON.stringify(
        {
          setupComplete: true,
          databaseUrl: "postgres://cfg-user:cfg-pass@db-host:5432/kaiad",
          redisUrl: "redis://redis-host:6379"
        },
        null,
        2
      )
    );

    vi.stubEnv("KAIAD_DATA_DIR", tempDataDir);
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("REDIS_URL", "");

    const result = bootstrapEnv();

    expect(result).toEqual({ setupComplete: true, configLoaded: true });
    expect(process.env.DATABASE_URL).toBe("postgres://cfg-user:cfg-pass@db-host:5432/kaiad");
    expect(process.env.REDIS_URL).toBe("redis://redis-host:6379");
  });

  it("overrides stale DATABASE_URL with configured value", () => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaiad-config-"));
    fs.writeFileSync(
      path.join(tempDataDir, "kaiad.config.json"),
      JSON.stringify(
        {
          setupComplete: true,
          databaseUrl: "postgres://new-user:new-pass@new-db:5432/kaiad"
        },
        null,
        2
      )
    );

    vi.stubEnv("KAIAD_DATA_DIR", tempDataDir);
    vi.stubEnv("DATABASE_URL", "postgres://old-user:old-pass@old-db:5432/kaiad");

    const result = bootstrapEnv();

    expect(result).toEqual({ setupComplete: true, configLoaded: true });
    expect(process.env.DATABASE_URL).toBe("postgres://new-user:new-pass@new-db:5432/kaiad");
  });
});
