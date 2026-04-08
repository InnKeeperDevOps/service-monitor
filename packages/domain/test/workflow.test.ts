import { describe, expect, it } from "vitest";
import {
  WORKFLOW_ACTION_KINDS,
  WORKFLOW_CONTROL_KINDS,
  WORKFLOW_EVENT_KINDS,
  validateWorkflowGraph,
  isWorkflowEventKind,
  WORKFLOW_NODE_CATEGORIES
} from "../src/workflow.js";

describe("workflow domain", () => {
  it("lists node categories and core kinds", () => {
    expect(WORKFLOW_NODE_CATEGORIES).toEqual(["event", "action", "control"]);
    expect(WORKFLOW_CONTROL_KINDS).toContain("join");
    expect(WORKFLOW_CONTROL_KINDS).toContain("branchIf");
    expect(WORKFLOW_EVENT_KINDS).toContain("onCrash");
    expect(WORKFLOW_EVENT_KINDS).toContain("agentStarted");
    expect(WORKFLOW_ACTION_KINDS).toContain("runShell");
  });

  it("identifies event kinds", () => {
    expect(isWorkflowEventKind("onLogPattern")).toBe(true);
    expect(isWorkflowEventKind("onBuild")).toBe(true);
    expect(isWorkflowEventKind("onShutdown")).toBe(true);
    expect(isWorkflowEventKind("runCursorPlan")).toBe(false);
  });

  it("rejects schedule on non-scheduled event kinds", () => {
    const errors = validateWorkflowGraph(
      [{ id: "n1", type: "event", kind: "onCrash", data: { schedule: "*/5 * * * *" } }],
      []
    );
    expect(errors.some((error) => error.code === "INVALID_EVENT_DATA")).toBe(true);
  });

  it("accepts valid schedule for onSchedule", () => {
    const errors = validateWorkflowGraph(
      [{ id: "n1", type: "event", kind: "onSchedule", data: { schedule: "*/5 * * * *" } }],
      []
    );
    expect(errors).toHaveLength(0);
  });

  it("rejects invalid schedule format for onSchedule", () => {
    const errors = validateWorkflowGraph(
      [{ id: "n1", type: "event", kind: "onSchedule", data: { schedule: "not-a-cron" } }],
      []
    );
    expect(errors.some((error) => error.code === "INVALID_EVENT_DATA")).toBe(true);
  });

  it("requires filter for onLogPattern", () => {
    const errors = validateWorkflowGraph(
      [{ id: "n1", type: "event", kind: "onLogPattern" }],
      []
    );
    expect(errors.some((error) => error.code === "MISSING_EVENT_DATA")).toBe(true);
  });

  it("rejects edges that point to event nodes", () => {
    const errors = validateWorkflowGraph(
      [
        { id: "e1", type: "event", kind: "onCrash" },
        { id: "a1", type: "action", kind: "runShell" }
      ],
      [{ from: "a1", to: "e1" }]
    );
    expect(errors.some((error) => error.code === "INVALID_EDGE_DIRECTION")).toBe(true);
  });

  it("rejects event-to-event edges", () => {
    const errors = validateWorkflowGraph(
      [
        { id: "e1", type: "event", kind: "onCrash" },
        { id: "e2", type: "event", kind: "onStartup" }
      ],
      [{ from: "e1", to: "e2" }]
    );
    expect(errors.some((error) => error.code === "INVALID_EDGE_DIRECTION")).toBe(true);
  });

  it("rejects invalid node category", () => {
    const errors = validateWorkflowGraph(
      [{ id: "n1", type: "invalid" as any, kind: "onCrash" }],
      []
    );
    expect(errors.some((error) => error.code === "INVALID_NODE_TYPE")).toBe(true);
  });

  it("rejects incompatible type and kind combinations", () => {
    const errors = validateWorkflowGraph(
      [{ id: "n1", type: "action", kind: "onCrash" as any }],
      []
    );
    expect(errors.some((error) => error.code === "INVALID_NODE_KIND")).toBe(true);
  });
});
