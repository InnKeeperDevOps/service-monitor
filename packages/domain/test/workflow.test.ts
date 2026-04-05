import { describe, expect, it } from "vitest";
import {
  validateWorkflowGraph,
  isWorkflowTriggerType,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_TRIGGER_TYPES
} from "../src/workflow.js";

describe("workflow domain", () => {
  it("lists MVP node types including triggers and join", () => {
    expect(WORKFLOW_NODE_TYPES).toContain("join");
    expect(WORKFLOW_NODE_TYPES).toContain("branchIf");
    expect(WORKFLOW_TRIGGER_TYPES).toContain("onCrash");
    expect(WORKFLOW_TRIGGER_TYPES).toContain("onBuild");
    expect(WORKFLOW_TRIGGER_TYPES).toContain("onShutdown");
  });

  it("identifies trigger types", () => {
    expect(isWorkflowTriggerType("onLogPattern")).toBe(true);
    expect(isWorkflowTriggerType("onBuild")).toBe(true);
    expect(isWorkflowTriggerType("onShutdown")).toBe(true);
    expect(isWorkflowTriggerType("runCursorPlan")).toBe(false);
  });

  it("rejects schedule on onCrash", () => {
    const errors = validateWorkflowGraph(
      [{ id: "n1", type: "onCrash", data: { schedule: "*/5 * * * *" } }],
      []
    );
    expect(errors.some((error) => error.code === "INVALID_TRIGGER_DATA")).toBe(true);
  });

  it("accepts valid schedule for onSchedule", () => {
    const errors = validateWorkflowGraph(
      [{ id: "n1", type: "onSchedule", data: { schedule: "*/5 * * * *" } }],
      []
    );
    expect(errors).toHaveLength(0);
  });

  it("requires filter for onLogPattern", () => {
    const errors = validateWorkflowGraph(
      [{ id: "n1", type: "onLogPattern" }],
      []
    );
    expect(errors.some((error) => error.code === "MISSING_TRIGGER_DATA")).toBe(true);
  });
});
