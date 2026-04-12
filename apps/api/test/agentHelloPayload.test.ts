import { describe, expect, it } from "vitest";
import { buildRealtimeAgentHello } from "../src/agentHelloPayload.js";

describe("buildRealtimeAgentHello", () => {
  it("defaults to docker backend when no settings exist", () => {
    const h = buildRealtimeAgentHello(undefined);
    expect(h.runtime?.backend).toBe("docker");
  });

  it("reflects kubernetes backend from settings", () => {
    const h = buildRealtimeAgentHello({
      tenantId: "t-1",
      agentRuntimeBackend: "kubernetes"
    });
    expect(h.runtime?.backend).toBe("kubernetes");
  });

  it("reflects shell backend from settings", () => {
    const h = buildRealtimeAgentHello({
      tenantId: "t-1",
      agentRuntimeBackend: "shell"
    });
    expect(h.runtime?.backend).toBe("shell");
  });

  it("includes preferredExecutor when configured", () => {
    const h = buildRealtimeAgentHello({
      tenantId: "t-1",
      preferredExecutor: "claude"
    });
    expect(h.preferredExecutor).toBe("claude");
  });

  it("omits preferredExecutor when not configured", () => {
    const h = buildRealtimeAgentHello({
      tenantId: "t-1"
    });
    expect(h.preferredExecutor).toBeUndefined();
  });
});
