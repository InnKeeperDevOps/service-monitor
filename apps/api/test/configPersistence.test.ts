import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigPath, readConfig, writeConfig } from "../src/configPersistence.js";

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: fsMock,
  ...fsMock
}));

describe("configPersistence", () => {
  const originalEnv = { ...process.env };
  
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  describe("getConfigPath", () => {
    it("returns path using KAIAD_DATA_DIR", () => {
      process.env.KAIAD_DATA_DIR = "/my/custom/data";
      const p = getConfigPath();
      expect(p).toBe(path.resolve("/my/custom/data", "kaiad.config.json"));
    });

    it("returns path using default ./data", () => {
      delete process.env.KAIAD_DATA_DIR;
      const p = getConfigPath();
      expect(p).toBe(path.resolve(process.cwd(), "data", "kaiad.config.json"));
    });
  });

  describe("readConfig", () => {
    it("returns null and suppresses log on ENOENT", () => {
      const err = new Error("not found") as any;
      err.code = "ENOENT";
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw err;
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      const config = readConfig();
      
      expect(config).toBeNull();
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("returns null and logs on other errors", () => {
      const err = new Error("permission denied") as any;
      err.code = "EACCES";
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw err;
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      const config = readConfig();
      
      expect(config).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
      consoleSpy.mockRestore();
    });

    it("returns parsed config on success", () => {
      const mockConfig = { setupComplete: true, databaseUrl: "postgres://db" };
      vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify(mockConfig));
      
      const config = readConfig();
      expect(config).toEqual(mockConfig);
    });
  });

  describe("writeConfig", () => {
    it("writes to tmp file and renames", async () => {
      const mockConfig = { setupComplete: true };
      
      await writeConfig(mockConfig);
      
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        JSON.stringify(mockConfig, null, 2),
        "utf-8"
      );
      expect(fs.chmodSync).toHaveBeenCalledWith(expect.stringContaining(".tmp"), 0o600);
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.stringContaining("kaiad.config.json")
      );
    });
  });
});
