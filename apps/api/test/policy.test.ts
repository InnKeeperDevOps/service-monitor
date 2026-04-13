import { describe, expect, it } from "vitest";
import { enforcePolicy } from "../src/policy.js";
import type { AutomationPolicy, AutomationAction } from "@sm/domain";

describe("policy", () => {
  const policy: AutomationPolicy = {
    repos: ["test-repo"],
    branches: ["main", "feature/*"],
    actions: ["create_pr", "push"]
  };

  it("returns allowed for permitted action", () => {
    const result = enforcePolicy(policy, { repo: "test-repo", branch: "main", action: "create_pr" });
    expect(result).toEqual({ allowed: true });
  });

  it("returns denied for prohibited action", () => {
    const result = enforcePolicy(policy, { repo: "test-repo", branch: "main", action: "dispatch_workflow" });
    expect(result).toEqual({ allowed: false, reason: "POLICY_DENY" });
  });

  it("returns denied for unknown repo", () => {
    const result = enforcePolicy(policy, { repo: "unknown-repo", branch: "main", action: "create_pr" });
    expect(result).toEqual({ allowed: false, reason: "POLICY_DENY" });
  });
});
