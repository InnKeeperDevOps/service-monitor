import * as yaml from "yaml";
import { workflowGraphSchema } from "@sm/contracts";
import type { WorkflowGraphNode } from "../../lib/api.js";
import {
  allowedEventDataKeys,
  isWorkflowEventKind,
  WORKFLOW_EVENT_KINDS,
  WORKFLOW_CONTROL_KINDS,
  WORKFLOW_NODE_TYPES,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowNodeType
} from "@sm/domain";
import type { Edge, Node } from "@xyflow/react";

export type WorkflowEditorNodeData = {
  nodeKind: WorkflowNodeKind;
  nodeType: WorkflowNodeType;
  label: string;
  displayName?: string;
  filter?: string;
  schedule?: string;
  command?: string;
  method?: string;
  url?: string;
  channel?: string;
  webhookRef?: string;
  condition?: string;
  template?: string;
  [key: string]: unknown;
};

export type WorkflowEditorVisualType = "eventNode" | "actionNode" | "controlNode";
export type WorkflowEditorNode = Node<WorkflowEditorNodeData, WorkflowEditorVisualType>;

const NODE_TYPE_SET = new Set<string>(WORKFLOW_NODE_TYPES);
const EVENT_KIND_SET = new Set<string>(WORKFLOW_EVENT_KINDS);
const CONTROL_KIND_SET = new Set<string>(WORKFLOW_CONTROL_KINDS);
const TRIGGER_PARAM_KEYS = new Set(["filter", "schedule"]);

export function isWorkflowNodeKind(value: string): value is WorkflowNodeKind {
  return NODE_TYPE_SET.has(value);
}

export function resolveNodeTypeFromKind(nodeKind: WorkflowNodeKind): WorkflowNodeType {
  if (EVENT_KIND_SET.has(nodeKind)) {
    return "event";
  }
  if (CONTROL_KIND_SET.has(nodeKind)) {
    return "control";
  }
  return "action";
}

export function resolveVisualType(nodeType: WorkflowNodeType): WorkflowEditorVisualType {
  if (nodeType === "event") {
    return "eventNode";
  }
  if (nodeType === "control") {
    return "controlNode";
  }
  return "actionNode";
}

export function sanitizeDataForNode(nodeType: WorkflowNodeType, nodeKind: WorkflowNodeKind, data: WorkflowEditorNodeData): WorkflowEditorNodeData {
  const nextData = { ...data };
  if (nodeType === "event" && isWorkflowEventKind(nodeKind)) {
    const allowedKeys = allowedEventDataKeys(nodeKind);
    for (const key of Object.keys(nextData)) {
      if (key === "nodeType" || key === "nodeKind" || key === "label") {
        continue;
      }
      if (!allowedKeys.has(key)) {
        delete nextData[key];
      }
    }
    return nextData;
  }
  for (const key of TRIGGER_PARAM_KEYS) {
    delete nextData[key];
  }
  return nextData;
}

export function getNodeLabel(data: WorkflowEditorNodeData): string {
  const custom = typeof data.displayName === "string" ? data.displayName.trim() : "";
  return custom.length > 0 ? custom : data.nodeKind;
}

export function sanitizeNodeData(data: WorkflowEditorNodeData): Record<string, unknown> | undefined {
  const { nodeType: _nodeType, nodeKind: _nodeKind, label: _label, ...rest } = data;
  const entries = Object.entries(rest).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

export function toWorkflowNodes(nodes: WorkflowEditorNode[]): WorkflowGraphNode[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.data.nodeType,
    kind: n.data.nodeKind,
    position: n.position,
    data: sanitizeNodeData(n.data)
  }));
}

export function toWorkflowEdges(edges: Edge[]): { from: string; to: string }[] {
  return edges.map((e) => ({ from: e.source, to: e.target }));
}

export function toDomainNodes(payloadNodes: WorkflowGraphNode[]): WorkflowNode[] {
  return payloadNodes.map(n => ({
    id: n.id,
    type: n.type as WorkflowNodeType,
    kind: n.kind as WorkflowNodeKind,
    position: n.position || { x: 0, y: 0 },
    data: n.data || {}
  }));
}

export function visualToYaml(name: string, nodes: WorkflowEditorNode[], edges: Edge[]): string {
  const graphObj = {
    name,
    nodes: toWorkflowNodes(nodes),
    edges: toWorkflowEdges(edges),
  };
  return yaml.stringify(graphObj);
}

export function yamlToVisual(yamlContent: string): { name?: string, nodes: WorkflowEditorNode[], edges: Edge[] } {
  let parsed;
  try {
    parsed = yaml.parse(yamlContent);
  } catch (err) {
    throw new Error(`YAML Parse Error: ${(err as Error).message}`);
  }

  const result = workflowGraphSchema.pick({ name: true, nodes: true, edges: true }).safeParse(parsed);
  
  if (!result.success) {
    throw new Error("Invalid YAML structure. Please fix errors before switching.");
  }

  const nodes = result.data.nodes.map((n: WorkflowGraphNode, i: number): WorkflowEditorNode => {
    const nodeType = n.type as WorkflowNodeType;
    const nodeKind = (n.kind || "runShell") as WorkflowNodeKind;
    const data = n.data ?? {};
    const displayName = typeof data.displayName === "string" ? data.displayName : "";
    return {
      id: n.id,
      type: resolveVisualType(nodeType),
      position: n.position ?? { x: i * 220, y: 120 },
      data: {
        ...data,
        nodeType,
        nodeKind,
        displayName,
        label: displayName.trim() || nodeKind
      }
    };
  });
  
  const edges = result.data.edges.map((e: { from: string; to: string }, i: number): Edge => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
  }));

  return { name: result.data.name, nodes, edges };
}

export function getActivePayload(
  editorMode: "visual" | "yaml",
  yamlContent: string,
  nodes: WorkflowEditorNode[],
  edges: Edge[],
  visualName: string
): { payloadName: string, payloadNodes: WorkflowGraphNode[], payloadEdges: { from: string; to: string }[] } {
  if (editorMode === "yaml") {
    let parsed;
    try {
      parsed = yaml.parse(yamlContent);
    } catch (err) {
      throw new Error(`YAML Parse Error: ${(err as Error).message}`);
    }
    const result = workflowGraphSchema.pick({ name: true, nodes: true, edges: true }).safeParse(parsed);
    if (!result.success) {
      throw new Error(`YAML Parse Error: Invalid YAML structure`);
    }
    return {
      payloadName: result.data.name || visualName,
      payloadNodes: result.data.nodes as WorkflowGraphNode[],
      payloadEdges: result.data.edges as { from: string; to: string }[]
    };
  } else {
    return {
      payloadName: visualName,
      payloadNodes: toWorkflowNodes(nodes),
      payloadEdges: toWorkflowEdges(edges)
    };
  }
}
