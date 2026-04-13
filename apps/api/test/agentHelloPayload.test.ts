import { describe, expect, it, vi } from "vitest";
import { buildRealtimeAgentHello } from "../src/agentHelloPayload.js";

describe("buildRealtimeAgentHello", () => {
  it("defaults to docker backend when no settings exist", () => {
    const h = buildRealtimeAgentHello(undefined);
    expect(h.runtime?.backend).toBe("docker");
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

  it("throws and logs on schema parse error", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      buildRealtimeAgentHello({
        tenantId: "t-1",
        preferredExecutor: "invalid-executor" as any
      });
    }).toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Parse Error in buildRealtimeAgentHello:", expect.anything());
    consoleSpy.mockRestore();
  });
});
