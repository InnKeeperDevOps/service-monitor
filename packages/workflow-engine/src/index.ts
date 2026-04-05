import {
  isWorkflowTriggerType,
  topologicalWaves,
  type WorkflowEdge,
  type WorkflowNode
} from "@sm/domain";

/**
 * Validates an MVP workflow graph: DAG, ≥1 trigger, and every non-trigger node on a path from some trigger.
 */
export function validateWorkflowGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
  if (nodes.length === 0) {
    throw new Error("Workflow must have at least one node");
  }

  topologicalWaves(nodes, edges);

  const triggers = nodes.filter((n) => isWorkflowTriggerType(n.type));
  if (triggers.length === 0) {
    throw new Error("Workflow must have at least one trigger node");
  }

  const outgoing = new Map<string, string[]>();
  for (const n of nodes) {
    outgoing.set(n.id, []);
  }
  for (const e of edges) {
    outgoing.get(e.from)?.push(e.to);
  }

  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const t of triggers) {
    if (!reachable.has(t.id)) {
      reachable.add(t.id);
      queue.push(t.id);
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of outgoing.get(id) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const unreachable: string[] = [];
  for (const n of nodes) {
    if (!isWorkflowTriggerType(n.type) && !reachable.has(n.id)) {
      unreachable.push(n.id);
    }
  }
  if (unreachable.length > 0) {
    throw new Error(
      `Workflow contains nodes not reachable from any trigger: ${unreachable.join(", ")}`
    );
  }
}

export { topologicalWaves };

export { executeWorkflow } from "./executor.js";
export type {
  ExecutionContext,
  NodeHandler,
  NodeResult,
  WorkflowResult
} from "./executor.js";
