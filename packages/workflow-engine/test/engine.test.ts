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
          { id: "t", type: "event", kind: "onCrash" },
          { id: "run", type: "action", kind: "runClaudePlan" },
          { id: "out", type: "action", kind: "slackNotify" }
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
          { id: "a", type: "event", kind: "onCrash" },
          { id: "b", type: "action", kind: "runShell" },
          { id: "c", type: "control", kind: "loop" }
        ],
        [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "b" }
        ]
      )
    ).toThrow(/cycle/i);
  });

  it("rejects a graph with no event nodes", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { id: "x", type: "action", kind: "dockerRun" },
          { id: "y", type: "action", kind: "emailNotify" }
        ],
        [{ from: "x", to: "y" }]
      )
    ).toThrow(/at least one event/i);
  });

  it("rejects non-event nodes unreachable from any event", () => {
    expect(() =>
      validateWorkflowGraph(
        [
          { id: "t", type: "event", kind: "onCrash" },
          { id: "ok", type: "action", kind: "runShell" },
          { id: "orphan", type: "action", kind: "genericWebhook" }
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
        { id: "t", type: "event", kind: "onCrash" },
        { id: "sh", type: "action", kind: "runShell" },
        { id: "notify", type: "action", kind: "slackNotify" }
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
        { id: "t", type: "event", kind: "onSchedule" },
        { id: "a", type: "action", kind: "runShell" },
        { id: "b", type: "action", kind: "dockerRun" },
        { id: "j", type: "control", kind: "join" }
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
        { id: "t", type: "event", kind: "onCrash" },
        { id: "fail-branch", type: "action", kind: "runShell" },
        { id: "ok-branch", type: "action", kind: "runShell" },
        { id: "after-fail", type: "action", kind: "slackNotify" },
        { id: "after-ok", type: "action", kind: "slackNotify" }
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
        { id: "t", type: "event", kind: "onCrash" },
        { id: "branch", type: "control", kind: "branchIf" },
        { id: "true-path", type: "action", kind: "runShell" },
        { id: "false-path", type: "action", kind: "emailNotify" }
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
        { id: "t1", type: "event", kind: "onCrash" },
        { id: "t2", type: "event", kind: "onStartup" },
        { id: "shared", type: "action", kind: "runShell" },
        { id: "notify", type: "action", kind: "slackNotify" }
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

  it("marks node as failed when handler is missing", async () => {
    const result = await executeWorkflow(
      [
        { id: "t", type: "event", kind: "onCrash" },
        { id: "a", type: "action", kind: "runShell" }
      ],
      [{ from: "t", to: "a" }],
      {
        onCrash: async () => ({ success: true, output: "ok" })
      },
      makeCtx()
    );

    expect(result.success).toBe(false);
    expect(result.nodeResults["a"]).toEqual({
      success: false,
      output: "No handler for kind: runShell"
    });
  });

  it("captures thrown handler errors as failed node results", async () => {
    const result = await executeWorkflow(
      [
        { id: "t", type: "event", kind: "onCrash" },
        { id: "a", type: "action", kind: "runShell" }
      ],
      [{ from: "t", to: "a" }],
      {
        onCrash: async () => ({ success: true, output: "ok" }),
        runShell: async () => {
          throw new Error("boom");
        }
      },
      makeCtx()
    );

    expect(result.success).toBe(false);
    expect(result.nodeResults["a"]).toEqual({
      success: false,
      output: "boom"
    });
  });

  it("branchIf false branch executes and true branch is skipped", async () => {
    const log: string[] = [];
    const handlers: Record<string, NodeHandler> = {
      onCrash: trackingHandler(log),
      branchIf: async (nodeId) => {
        log.push(nodeId);
        return { success: true, output: "branched", branchTaken: "false" };
      },
      runShell: trackingHandler(log),
      emailNotify: trackingHandler(log)
    };

    const result = await executeWorkflow(
      [
        { id: "t", type: "event", kind: "onCrash" },
        { id: "branch", type: "control", kind: "branchIf" },
        { id: "true-path", type: "action", kind: "runShell" },
        { id: "false-path", type: "action", kind: "emailNotify" }
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
    expect(log).toContain("false-path");
    expect(log).not.toContain("true-path");
    expect(result.context.outputs["false-path"]).toBe("false-path-done");
    expect(result.context.outputs["true-path"]).toBeUndefined();
  });
  it("if: true branch executes and no downstream is skipped", async () => {
    const log: string[] = [];
    const handlers: Record<string, NodeHandler> = {
      onCrash: trackingHandler(log),
      if: async (nodeId) => {
        log.push(nodeId);
        return { success: true, output: "evaluated", branchTaken: "true" };
      },
      runShell: trackingHandler(log)
    };

    const result = await executeWorkflow(
      [
        { id: "t", type: "event", kind: "onCrash" },
        { id: "if-node", type: "control", kind: "if" },
        { id: "target-path", type: "action", kind: "runShell" }
      ],
      [
        { from: "t", to: "if-node" },
        { from: "if-node", to: "target-path" }
      ],
      handlers,
      makeCtx()
    );

    expect(result.success).toBe(true);
    expect(log).toContain("target-path");
    expect(result.context.outputs["target-path"]).toBe("target-path-done");
  });

  it("if: false branch executes and downstream is skipped", async () => {
    const log: string[] = [];
    const handlers: Record<string, NodeHandler> = {
      onCrash: trackingHandler(log),
      if: async (nodeId) => {
        log.push(nodeId);
        return { success: true, output: "evaluated", branchTaken: "false" };
      },
      runShell: trackingHandler(log)
    };

    const result = await executeWorkflow(
      [
        { id: "t", type: "event", kind: "onCrash" },
        { id: "if-node", type: "control", kind: "if" },
        { id: "target-path", type: "action", kind: "runShell" }
      ],
      [
        { from: "t", to: "if-node" },
        { from: "if-node", to: "target-path" }
      ],
      handlers,
      makeCtx()
    );

    expect(result.success).toBe(true);
    expect(log).not.toContain("target-path");
    expect(result.context.outputs["target-path"]).toBeUndefined();
  });

  it("split: executes all targets without branch matching", async () => {
    const log: string[] = [];
    const handlers: Record<string, NodeHandler> = {
      onCrash: trackingHandler(log),
      split: trackingHandler(log),
      runShell: trackingHandler(log),
      emailNotify: trackingHandler(log)
    };

    const result = await executeWorkflow(
      [
        { id: "t", type: "event", kind: "onCrash" },
        { id: "split-node", type: "control", kind: "split" },
        { id: "target-path-1", type: "action", kind: "runShell" },
        { id: "target-path-2", type: "action", kind: "emailNotify" }
      ],
      [
        { from: "t", to: "split-node" },
        { from: "split-node", to: "target-path-1" },
        { from: "split-node", to: "target-path-2" }
      ],
      handlers,
      makeCtx()
    );

    expect(result.success).toBe(true);
    expect(log).toContain("target-path-1");
    expect(log).toContain("target-path-2");
  });
});
