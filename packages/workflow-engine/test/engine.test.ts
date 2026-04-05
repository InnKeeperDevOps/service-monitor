import { describe, expect, it } from "vitest";
import {
  validateWorkflowGraph,
  executeWorkflow,
  type ExecutionContext,
  type NodeHandler
} from "../src/index.js";

describe("workflow engine", () => {
  it("accepts a valid acyclic graph with a trigger and reachable actions", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { id: "t", type: "onCrash" },
          { id: "run", type: "runClaudePlan" },
          { id: "out", type: "slackNotify" }
        ],
        [
          { from: "t", to: "run" },
          { from: "run", to: "out" }
        ]
      )
    ).not.toThrow();
  });

  it("rejects a cyclic graph", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { id: "a", type: "onCrash" },
          { id: "b", type: "runShell" }
        ],
        [
          { from: "a", to: "b" },
          { from: "b", to: "a" }
        ]
      )
    ).toThrow(/cycle/i);
  });

  it("rejects a graph with no trigger nodes", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { id: "x", type: "dockerRun" },
          { id: "y", type: "emailNotify" }
        ],
        [{ from: "x", to: "y" }]
      )
    ).toThrow(/at least one trigger/i);
  });

  it("rejects non-trigger nodes unreachable from any trigger", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { id: "t", type: "onSchedule" },
          { id: "ok", type: "runShell" },
          { id: "orphan", type: "genericWebhook" }
        ],
        [
          { from: "t", to: "ok" }
          // orphan is disconnected from the trigger component
        ]
      )
    ).toThrow(/not reachable/i);
  });
});

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    env: {},
    outputs: {},
    triggerPayload: null,
    ...overrides
  };
}

function trackingHandler(log: string[]): NodeHandler {
  return async (nodeId, _node, ctx) => {
    log.push(nodeId);
    return { success: true, output: `${nodeId}-done` };
  };
}

describe("executeWorkflow", () => {
  it("linear 3-node graph: trigger → shell → notify with context propagation", async () => {
    const log: string[] = [];
    const handler = trackingHandler(log);
    const handlers: Record<string, NodeHandler> = {
      onCrash: handler,
      runShell: handler,
      slackNotify: handler
    };

    const result = await executeWorkflow(
      [
        { id: "t", type: "onCrash" },
        { id: "sh", type: "runShell" },
        { id: "notify", type: "slackNotify" }
      ],
      [
        { from: "t", to: "sh" },
        { from: "sh", to: "notify" }
      ],
      handlers,
      makeCtx({ triggerPayload: { service: "api" } })
    );

    expect(result.success).toBe(true);
    expect(log).toEqual(["t", "sh", "notify"]);
    expect(result.context.outputs["t"]).toBe("t-done");
    expect(result.context.outputs["sh"]).toBe("sh-done");
    expect(result.context.outputs["notify"]).toBe("notify-done");
    expect(result.context.triggerPayload).toEqual({ service: "api" });
  });

  it("fork+join: trigger → 2 branches → join with both outputs in context", async () => {
    const log: string[] = [];
    const handler = trackingHandler(log);
    const handlers: Record<string, NodeHandler> = {
      onSchedule: handler,
      runShell: handler,
      dockerRun: handler,
      join: handler
    };

    const result = await executeWorkflow(
      [
        { id: "t", type: "onSchedule" },
        { id: "a", type: "runShell" },
        { id: "b", type: "dockerRun" },
        { id: "j", type: "join" }
      ],
      [
        { from: "t", to: "a" },
        { from: "t", to: "b" },
        { from: "a", to: "j" },
        { from: "b", to: "j" }
      ],
      handlers,
      makeCtx()
    );

    expect(result.success).toBe(true);
    expect(log[0]).toBe("t");
    expect(log).toContain("a");
    expect(log).toContain("b");
    expect(log[log.length - 1]).toBe("j");
    expect(result.context.outputs["a"]).toBe("a-done");
    expect(result.context.outputs["b"]).toBe("b-done");
    expect(result.context.outputs["j"]).toBe("j-done");
  });

  it("partial failure: one branch fails, other branch runs, downstream of failure skipped", async () => {
    const handlers: Record<string, NodeHandler> = {
      onCrash: async () => ({ success: true, output: "triggered" }),
      runShell: async (nodeId) => {
        if (nodeId === "fail-branch") {
          return { success: false, output: "error!" };
        }
        return { success: true, output: `${nodeId}-ok` };
      },
      slackNotify: async (nodeId) => ({ success: true, output: `${nodeId}-notified` })
    };

    const result = await executeWorkflow(
      [
        { id: "t", type: "onCrash" },
        { id: "fail-branch", type: "runShell" },
        { id: "ok-branch", type: "runShell" },
        { id: "after-fail", type: "slackNotify" },
        { id: "after-ok", type: "slackNotify" }
      ],
      [
        { from: "t", to: "fail-branch" },
        { from: "t", to: "ok-branch" },
        { from: "fail-branch", to: "after-fail" },
        { from: "ok-branch", to: "after-ok" }
      ],
      handlers,
      makeCtx()
    );

    expect(result.success).toBe(false);
    expect(result.nodeResults["fail-branch"].success).toBe(false);
    expect(result.nodeResults["ok-branch"].success).toBe(true);
    expect(result.nodeResults["after-ok"].success).toBe(true);
    expect(result.nodeResults["after-fail"]).toBeUndefined();
  });

  it("branchIf: true branch executes, false branch skipped", async () => {
    const log: string[] = [];
    const handlers: Record<string, NodeHandler> = {
      onCrash: trackingHandler(log),
      branchIf: async (nodeId, _node, ctx) => {
        log.push(nodeId);
        return { success: true, output: "branched", branchTaken: "true" };
      },
      runShell: trackingHandler(log),
      emailNotify: trackingHandler(log)
    };

    const result = await executeWorkflow(
      [
        { id: "t", type: "onCrash" },
        { id: "branch", type: "branchIf" },
        { id: "true-path", type: "runShell" },
        { id: "false-path", type: "emailNotify" }
      ],
      [
        { from: "t", to: "branch" },
        { from: "branch", to: "true-path" },
        { from: "branch", to: "false-path" }
      ],
      handlers,
      makeCtx()
    );

    expect(result.success).toBe(true);
    expect(log).toContain("true-path");
    expect(log).not.toContain("false-path");
    expect(result.context.outputs["true-path"]).toBe("true-path-done");
    expect(result.context.outputs["false-path"]).toBeUndefined();
  });

  it("multiple triggers into shared subgraph", async () => {
    const log: string[] = [];
    const handler = trackingHandler(log);
    const handlers: Record<string, NodeHandler> = {
      onCrash: handler,
      onStartup: handler,
      runShell: handler,
      slackNotify: handler
    };

    const result = await executeWorkflow(
      [
        { id: "t1", type: "onCrash" },
        { id: "t2", type: "onStartup" },
        { id: "shared", type: "runShell" },
        { id: "notify", type: "slackNotify" }
      ],
      [
        { from: "t1", to: "shared" },
        { from: "t2", to: "shared" },
        { from: "shared", to: "notify" }
      ],
      handlers,
      makeCtx()
    );

    expect(result.success).toBe(true);
    expect(log).toContain("t1");
    expect(log).toContain("t2");
    expect(log).toContain("shared");
    expect(log).toContain("notify");
    expect(result.context.outputs["shared"]).toBe("shared-done");
    expect(result.context.outputs["notify"]).toBe("notify-done");
  });
});
