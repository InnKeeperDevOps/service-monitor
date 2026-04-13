import { describe, expect, it, vi } from "vitest";
import { runWorkflow } from "../src/workflow-execution.js";

// Mock child_process and fs
vi.mock("node:child_process", () => {
  const mockExec: any = () => {};
  mockExec[Symbol.for("nodejs.util.promisify.custom")] = async (cmd: string) => {
    if (cmd.includes("fail")) {
      throw new Error("Command failed");
    }
    return { stdout: `Mocked output for: ${cmd}`, stderr: "" };
  };
  return { exec: mockExec };
});

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined)
  }
}));

describe("workflow-execution", () => {
  it("runs workflow successfully", async () => {
    const rawJob = {
      workflowExecutionId: "w-1",
      tenantId: "t-1",
      serviceId: "s-1",
      workflowGraphId: "g-1",
      workflowVersion: 1,
      triggerPayload: null,
      nodes: [
        { id: "1", type: "trigger", kind: "onCrash", data: { type: "onCrash" } },
        { id: "2", type: "action", kind: "runShell", data: { command: "echo hello" } },
        { id: "3", type: "action", kind: "runGradlew", data: { command: "build" } },
        { id: "4", type: "action", kind: "runPip", data: { command: "install" } },
        { id: "5", type: "action", kind: "runNpm", data: { command: "install" } },
        { id: "6", type: "action", kind: "runMaven", data: { command: "clean install" } },
        { id: "7", type: "action", kind: "runGo", data: { command: "build" } }
      ],
      edges: [
        { id: "e1", from: "1", to: "2" },
        { id: "e2", from: "2", to: "3" },
        { id: "e3", from: "3", to: "4" },
        { id: "e4", from: "4", to: "5" },
        { id: "e5", from: "5", to: "6" },
        { id: "e6", from: "6", to: "7" }
      ]
    };

    const res = await runWorkflow(rawJob);
    expect(res.success).toBe(true);
    expect(res.log).toContain("Success: true");
    expect(res.log).toContain("Mocked output for: echo hello");
    expect(res.log).toContain("Mocked output for: ./gradlew build");
    expect(res.log).toContain("Mocked output for: pip install");
    expect(res.log).toContain("Mocked output for: npm install");
    expect(res.log).toContain("Mocked output for: mvn clean install");
    expect(res.log).toContain("Mocked output for: go build");
  });

  it("handles failed commands gracefully", async () => {
    const rawJob = {
      workflowExecutionId: "w-2",
      tenantId: "t-1",
      serviceId: "s-1",
      workflowGraphId: "g-1",
      workflowVersion: 1,
      triggerPayload: null,
      nodes: [
        { id: "1", type: "trigger", kind: "agentStarted", data: { type: "agentStarted" } },
        { id: "2", type: "action", kind: "runShell", data: { command: "fail-command" } }
      ],
      edges: [
        { id: "e1", from: "1", to: "2" }
      ]
    };

    const res = await runWorkflow(rawJob);
    expect(res.success).toBe(false);
    expect(res.log).toContain("Success: false");
    expect(res.log).toContain("Command failed");
  });

  it("handles missing command string", async () => {
    const rawJob = {
      workflowExecutionId: "w-3",
      tenantId: "t-1",
      serviceId: "s-1",
      workflowGraphId: "g-1",
      workflowVersion: 1,
      triggerPayload: null,
      nodes: [
        { id: "1", type: "trigger", kind: "onCrash", data: { type: "onCrash" } },
        { id: "2", type: "action", kind: "runShell", data: {} }
      ],
      edges: [
        { id: "e1", from: "1", to: "2" }
      ]
    };

    const res = await runWorkflow(rawJob);
    expect(res.success).toBe(true);
    expect(res.log).toContain("No command provided");
  });
});
