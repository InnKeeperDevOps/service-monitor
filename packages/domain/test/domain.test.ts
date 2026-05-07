import { describe, expect, it } from "vitest";
import { fingerprintError, isActionAllowed } from "../src/index.js";

describe("domain", () => {
  it("builds stable fingerprints for similar volatile messages", () => {
    const a = fingerprintError("PID=42 failed at 2026-01-01T00:00:00.000Z");
    const b = fingerprintError("PID=99 failed at 2026-01-01T00:00:01.000Z");
    expect(a).toBe(b);
  });

  it("enforces allowlist policy", () => {
    expect(
      isActionAllowed(
        { repos: ["org/repo"], branches: ["main"], actions: ["merge_pr"] },
        "org/repo",
        "main",
        "merge_pr"
      )
    ).toBe(true);
    expect(
      isActionAllowed(
        { repos: ["org/repo"], branches: ["main"], actions: ["merge_pr"] },
        "org/repo",
        "dev",
        "merge_pr"
      )
    ).toBe(false);
  });
});
