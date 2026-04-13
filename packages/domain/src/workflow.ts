export const WORKFLOW_NODE_CATEGORIES = ["event", "action", "control"] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_CATEGORIES)[number];

export const WORKFLOW_EVENT_KINDS = [
  "onBuild",
  "onStartup",
  "onCrash",
  "onShutdown",
  "onLogPattern",
  "onSchedule",
  "agentStarted",
  "agentStopped",
  "agentOnline",
  "agentOffline",
  "agentCrashed",
  "agentRestarted",
  "onServiceConfigurationUpdate"
] as const;

export const WORKFLOW_CONTROL_KINDS = ["branchIf", "join", "wait", "if", "loop"] as const;

export const WORKFLOW_ACTION_KINDS = [
  "runShell",
  "runGradlew",
  "runPip",
  "runNpm",
  "runMaven",
  "runGo",
  "dockerBuild",
  "dockerRun",
  "composeUp",
  "composeDown",
  "setEnv",
  "injectSecret",
  "template",
  "runCursorPlan",
  "runClaudePlan",
  "httpRequest",
  "slackNotify",
  "emailNotify",
  "genericWebhook",
  "clone",
  "checkoutBranch",
  "createPR",
  "mergePR",
  "push",
  "dispatchWorkflow",
  "commentOnPR",
  "createIssue",
  "addLabels"
] as const;

export type WorkflowNodeKind =
  | (typeof WORKFLOW_EVENT_KINDS)[number]
  | (typeof WORKFLOW_ACTION_KINDS)[number]
  | (typeof WORKFLOW_CONTROL_KINDS)[number];

const EVENT_KIND_SET = new Set<string>(WORKFLOW_EVENT_KINDS);
const ACTION_KIND_SET = new Set<string>(WORKFLOW_ACTION_KINDS);
const CONTROL_KIND_SET = new Set<string>(WORKFLOW_CONTROL_KINDS);
const NODE_CATEGORY_SET = new Set<string>(WORKFLOW_NODE_CATEGORIES);
const CRON_SCHEDULE_REGEX = /^(\S+\s+){4}\S+$/;

export const WORKFLOW_EVENT_DATA_SPEC: Record<
  (typeof WORKFLOW_EVENT_KINDS)[number],
  { optionalKeys: readonly string[]; requiredKeys: readonly string[] }
> = {
  onBuild: { optionalKeys: [], requiredKeys: [] },
  onStartup: { optionalKeys: [], requiredKeys: [] },
  onCrash: { optionalKeys: [], requiredKeys: [] },
  onShutdown: { optionalKeys: [], requiredKeys: [] },
  onLogPattern: { optionalKeys: [], requiredKeys: ["filter"] },
  onSchedule: { optionalKeys: [], requiredKeys: ["schedule"] },
  agentStarted: { optionalKeys: [], requiredKeys: [] },
  agentStopped: { optionalKeys: [], requiredKeys: [] },
  agentOnline: { optionalKeys: [], requiredKeys: [] },
  agentOffline: { optionalKeys: [], requiredKeys: [] },
  agentCrashed: { optionalKeys: [], requiredKeys: [] },
  agentRestarted: { optionalKeys: [], requiredKeys: [] },
  onServiceConfigurationUpdate: { optionalKeys: [], requiredKeys: [] }
};

export function isWorkflowEventKind(kind: WorkflowNodeKind): kind is (typeof WORKFLOW_EVENT_KINDS)[number] {
  return EVENT_KIND_SET.has(kind);
}

export function allowedEventDataKeys(kind: (typeof WORKFLOW_EVENT_KINDS)[number]): Set<string> {
  const spec = WORKFLOW_EVENT_DATA_SPEC[kind];
  return new Set(["displayName", ...spec.optionalKeys, ...spec.requiredKeys]);
}

/** Backward-compatible aliases for code paths not yet migrated. */
export const WORKFLOW_NODE_TYPES = [
  ...WORKFLOW_EVENT_KINDS,
  ...WORKFLOW_ACTION_KINDS,
  ...WORKFLOW_CONTROL_KINDS
] as const;
export const WORKFLOW_TRIGGER_TYPES = [
  "onBuild",
  "onStartup",
  "onCrash",
  "onShutdown",
  "onLogPattern",
  "onSchedule",
  "onServiceConfigurationUpdate"
] as const;
export const WORKFLOW_TRIGGER_DATA_SPEC = WORKFLOW_EVENT_DATA_SPEC;
export function isWorkflowTriggerType(kind: WorkflowNodeKind): boolean {
  return new Set<string>(WORKFLOW_TRIGGER_TYPES).has(kind);
}
export function allowedTriggerDataKeys(kind: (typeof WORKFLOW_TRIGGER_TYPES)[number]): Set<string> {
  return allowedEventDataKeys(kind);
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  kind: WorkflowNodeKind;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
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
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    if (!NODE_CATEGORY_SET.has(node.type)) {
      errors.push({ code: "INVALID_NODE_TYPE", message: `Unknown node type "${node.type}"`, nodeId: node.id });
      continue;
    }

    if (!node.kind) {
      errors.push({ code: "INVALID_NODE_KIND", message: `Node "${node.id}" is missing required "kind"`, nodeId: node.id });
      continue;
    }

    if (
      (node.type === "event" && !EVENT_KIND_SET.has(node.kind)) ||
      (node.type === "action" && !ACTION_KIND_SET.has(node.kind)) ||
      (node.type === "control" && !CONTROL_KIND_SET.has(node.kind))
    ) {
      errors.push({
        code: "INVALID_NODE_KIND",
        message: `Node "${node.id}" has kind "${node.kind}" incompatible with type "${node.type}"`,
        nodeId: node.id
      });
      continue;
    }

    if (node.type === "event") {
      const eventKind = node.kind as (typeof WORKFLOW_EVENT_KINDS)[number];
      const allowedKeys = allowedEventDataKeys(eventKind);
      const data = node.data ?? {};
      for (const key of Object.keys(data)) {
        if (!allowedKeys.has(key)) {
          errors.push({
            code: "INVALID_EVENT_DATA",
            message: `Event "${node.kind}" does not allow data key "${key}"`,
            nodeId: node.id
          });
        }
      }

      const spec = WORKFLOW_EVENT_DATA_SPEC[eventKind];
      for (const requiredKey of spec.requiredKeys) {
        const value = data[requiredKey];
        if (typeof value !== "string" || value.trim().length === 0) {
          errors.push({
            code: "MISSING_EVENT_DATA",
            message: `Event "${node.kind}" requires non-empty "${requiredKey}"`,
            nodeId: node.id
          });
        }
      }

      if (eventKind === "onSchedule") {
        const scheduleValue = data.schedule;
        if (typeof scheduleValue === "string" && scheduleValue.trim().length > 0 && !CRON_SCHEDULE_REGEX.test(scheduleValue.trim())) {
          errors.push({
            code: "INVALID_EVENT_DATA",
            message: `Event "onSchedule" has invalid cron schedule "${scheduleValue}"`,
            nodeId: node.id
          });
        }
      }
    }
  }

  const hasEvent = nodes.some((n) => n.type === "event");
  if (!hasEvent) {
    errors.push({ code: "NO_EVENT", message: "Workflow must contain at least one event node" });
  }

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (!nodeIds.has(edge.from)) {
      errors.push({ code: "DANGLING_EDGE", message: `Edge source "${edge.from}" does not match any node`, edgeIndex: i });
    }
    if (!nodeIds.has(edge.to)) {
      errors.push({ code: "DANGLING_EDGE", message: `Edge target "${edge.to}" does not match any node`, edgeIndex: i });
    }
    const sourceNode = nodeById.get(edge.from);
    const targetNode = nodeById.get(edge.to);
    if (!sourceNode || !targetNode) {
      continue;
    }

    if (sourceNode.type === "event" && targetNode.type === "event") {
      errors.push({
        code: "INVALID_EDGE_DIRECTION",
        message: `Event node "${edge.from}" cannot connect to event node "${edge.to}"`,
        edgeIndex: i
      });
      continue;
    }

    if (targetNode.type === "event") {
      errors.push({
        code: "INVALID_EDGE_DIRECTION",
        message: `Edges cannot target event node "${edge.to}"`,
        edgeIndex: i
      });
    }
  }

  try {
    topologicalWaves(nodes, edges);
  } catch {
    errors.push({ code: "CYCLE", message: "Workflow graph contains a cycle" });
  }

  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
  }

  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const eventNode of nodes) {
    if (eventNode.type === "event" && !reachable.has(eventNode.id)) {
      reachable.add(eventNode.id);
      queue.push(eventNode.id);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const target of outgoing.get(current) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }

  for (const node of nodes) {
    if (node.type !== "event" && !reachable.has(node.id)) {
      errors.push({
        code: "UNREACHABLE_NODE",
        message: `Node "${node.id}" is not reachable from any event`,
        nodeId: node.id
      });
    }
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
