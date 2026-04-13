import { describe, expect, it } from "vitest";
import { createReadinessCheckersFromEnv, parsePort } from "../src/readyChecks.js";

describe("readyChecks", () => {
  it("parsePort handles invalid ports", () => {
    expect(parsePort("NaN")).toBeNull();
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("8080")).toBe(8080);
  });

  it("createReadinessCheckersFromEnv handles invalid POSTGRES_PORT", async () => {
    const checkers = createReadinessCheckersFromEnv({
      POSTGRES_HOST: "localhost",
      POSTGRES_PORT: "invalid"
    });
    expect(checkers).toHaveLength(1);
    const result = await checkers[0]();
    expect(result).toEqual({
      ok: false,
      code: "POSTGRES_CONFIG_INVALID",
      message: "POSTGRES_PORT must be a valid TCP port (1–65535)"
    });
  });

  it("createReadinessCheckersFromEnv handles invalid REDIS_PORT", async () => {
    const checkers = createReadinessCheckersFromEnv({
      REDIS_HOST: "localhost",
      REDIS_PORT: "invalid"
    });
    expect(checkers).toHaveLength(1);
    const result = await checkers[0]();
    expect(result).toEqual({
      ok: false,
      code: "REDIS_CONFIG_INVALID",
      message: "REDIS_PORT must be a valid TCP port (1–65535)"
    });
  });
});
