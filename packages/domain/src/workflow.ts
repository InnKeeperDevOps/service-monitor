/** MVP workflow node kinds (triggers, actions, control). */
export const WORKFLOW_NODE_TYPES = [
  // Triggers
  "onBuild",
  "onStartup",
  "onCrash",
  "onShutdown",
  "onLogPattern",
  "onSchedule",
  // Docker/shell actions
  "runShell",
  "dockerBuild",
  "dockerRun",
  "composeUp",
  "composeDown",
  // Environment
  "setEnv",
  "injectSecret",
  // Control flow
  "wait",
  "join",
  "branchIf",
  "template",
  // Remediation
  "runCursorPlan",
  "runClaudePlan",
  // Integrations
  "httpRequest",
  "slackNotify",
  "emailNotify",
  "genericWebhook",
  // GitHub
  "clone",
  "checkoutBranch",
  "createPR",
  "mergePR",
  "push",
  "dispatchWorkflow",
  "commentOnPR",
  "createIssue",
  "addLabels",
] as const;

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export const WORKFLOW_TRIGGER_TYPES = [
  "onBuild",
  "onStartup",
  "onCrash",
  "onShutdown",
  "onLogPattern",
  "onSchedule"
] as const satisfies readonly WorkflowNodeType[];

const TRIGGER_SET = new Set<string>(WORKFLOW_TRIGGER_TYPES);

export function isWorkflowTriggerType(type: WorkflowNodeType): boolean {
  return TRIGGER_SET.has(type);
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeIndex?: number;
}

const NODE_TYPE_SET = new Set<string>(WORKFLOW_NODE_TYPES);

export function validateWorkflowGraph(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];

  if (nodes.length === 0) {
    errors.push({ code: "EMPTY_GRAPH", message: "Workflow must have at least one node" });
    return errors;
  }

  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    if (!NODE_TYPE_SET.has(node.type)) {
      errors.push({ code: "INVALID_NODE_TYPE", message: `Unknown node type "${node.type}"`, nodeId: node.id });
    }
  }

  const hasTrigger = nodes.some((n) => TRIGGER_SET.has(n.type));
  if (!hasTrigger) {
    errors.push({ code: "NO_TRIGGER", message: "Workflow must contain at least one trigger node" });
  }

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (!nodeIds.has(edge.from)) {
      errors.push({ code: "DANGLING_EDGE", message: `Edge source "${edge.from}" does not match any node`, edgeIndex: i });
    }
    if (!nodeIds.has(edge.to)) {
      errors.push({ code: "DANGLING_EDGE", message: `Edge target "${edge.to}" does not match any node`, edgeIndex: i });
    }
  }

  try {
    topologicalWaves(nodes, edges);
  } catch {
    errors.push({ code: "CYCLE", message: "Workflow graph contains a cycle" });
  }

  return errors;
}

export function topologicalWaves(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const waves: string[][] = [];
  let queue = [...nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id)];

  while (queue.length) {
    waves.push(queue);
    const next: string[] = [];
    for (const nodeId of queue) {
      for (const target of outgoing.get(nodeId) ?? []) {
        const newDegree = (inDegree.get(target) ?? 0) - 1;
        inDegree.set(target, newDegree);
        if (newDegree === 0) {
          next.push(target);
        }
      }
    }
    queue = next;
  }

  const unresolved = [...inDegree.values()].some((degree) => degree > 0);
  if (unresolved) {
    throw new Error("Workflow graph contains a cycle");
  }

  return waves;
}
