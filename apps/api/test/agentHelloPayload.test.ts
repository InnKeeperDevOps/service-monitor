import { describe, expect, it } from "vitest";
import { buildRealtimeAgentHello } from "../src/agentHelloPayload.js";

describe("buildRealtimeAgentHello", () => {
  it("uses ready GitHub mode when settings omit agentWorkloadSource (legacy)", () => {
    const h = buildRealtimeAgentHello({
      tenantId: "t-1",
      githubRepo: "acme/app",
      defaultBranch: "main"
    });
    expect(h.configReady).toBe(true);
    expect(h.workload?.source).toBe("github_repo");
    expect(h.workload?.githubRepo).toBe("acme/app");
  });

  it("marks not ready when agentWorkloadSource is null", () => {
    const h = buildRealtimeAgentHello({
      tenantId: "t-1",
      githubRepo: "acme/app",
      defaultBranch: "main",
      agentWorkloadSource: null
    });
    expect(h.configReady).toBe(false);
    expect(h.workload?.source).toBeNull();
  });

  it("passes through binary workload", () => {
    const h = buildRealtimeAgentHello({
      tenantId: "t-1",
      githubRepo: "acme/app",
      defaultBranch: "main",
      agentWorkloadSource: "binary"
    });
    expect(h.configReady).toBe(true);
    expect(h.workload?.source).toBe("binary");
  });

  it("defaults when no tenant row", () => {
    const h = buildRealtimeAgentHello(undefined);
    expect(h.configReady).toBe(true);
    expect(h.workload?.source).toBe("github_repo");
  });
});
