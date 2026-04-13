import {
  validateWorkflowGraph as validateDomainWorkflowGraph,
  topologicalWaves,
  type WorkflowEdge,
  type WorkflowNode
} from "@sm/domain";

/**
 * Validates an MVP workflow graph: DAG, ≥1 trigger, and every non-trigger node on a path from some trigger.
 */
export function validateWorkflowGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
  const errors = validateDomainWorkflowGraph(nodes, edges);
  if (errors.length > 0) {
    throw new Error(errors[0].message);
  }
}

export { topologicalWaves };

export { executeWorkflow, markDescendantsSkipped } from "./executor.js";
export type {
  ExecutionContext,
  NodeHandler,
  NodeResult,
  WorkflowResult
} from "./executor.js";
