import { describe, expect, it } from "vitest";
import {
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
});
