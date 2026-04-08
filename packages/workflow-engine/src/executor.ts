import { topologicalWaves, type WorkflowEdge, type WorkflowNode } from "@sm/domain";

export interface ExecutionContext {
  env: Record<string, string>;
  outputs: Record<string, unknown>;
  triggerPayload: unknown;
}

export interface NodeResult {
  success: boolean;
  output?: unknown;
  branchTaken?: "true" | "false";
}

export type NodeHandler = (
  nodeId: string,
  node: WorkflowNode,
  ctx: ExecutionContext
) => Promise<NodeResult>;

export interface WorkflowResult {
  success: boolean;
  context: ExecutionContext;
  nodeResults: Record<string, NodeResult>;
}

export async function executeWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  handlers: Record<string, NodeHandler>,
  initialContext: ExecutionContext
): Promise<WorkflowResult> {
  const ctx: ExecutionContext = {
    env: { ...initialContext.env },
    outputs: { ...initialContext.outputs },
    triggerPayload: initialContext.triggerPayload
  };

  const waves = topologicalWaves(nodes, edges);
  const nodeMap = new Map<string, WorkflowNode>(nodes.map((n) => [n.id, n]));

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const n of nodes) {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of edges) {
    outgoing.get(e.from)!.push(e.to);
    incoming.get(e.to)!.push(e.from);
  }

  const nodeResults: Record<string, NodeResult> = {};
  const skipped = new Set<string>();
  const failed = new Set<string>();

  for (const wave of waves) {
    const executableNodes = wave.filter((id) => !skipped.has(id));

    await Promise.all(
      executableNodes.map(async (nodeId) => {
        const node = nodeMap.get(nodeId)!;

        const incomingNodes = incoming.get(nodeId) ?? [];
        const allIncomingFailed = incomingNodes.length > 0 && incomingNodes.every(
          (src) => failed.has(src) || skipped.has(src)
        );
        if (allIncomingFailed) {
          skipped.add(nodeId);
          return;
        }

        const handler = handlers[node.kind];
        if (!handler) {
          const result: NodeResult = { success: false, output: `No handler for kind: ${node.kind}` };
          nodeResults[nodeId] = result;
          failed.add(nodeId);
          return;
        }

        try {
          const result = await handler(nodeId, node, ctx);
          nodeResults[nodeId] = result;
          ctx.outputs[nodeId] = result.output;

          if (!result.success) {
            failed.add(nodeId);
          }

          if (node.kind === "branchIf" && result.branchTaken) {
            const targets = outgoing.get(nodeId) ?? [];
            const takenIndex = result.branchTaken === "true" ? 0 : 1;
            for (let i = 0; i < targets.length; i++) {
              if (i !== takenIndex) {
                markDescendantsSkipped(targets[i], outgoing, skipped);
              }
            }
          }
        } catch (err) {
          const result: NodeResult = {
            success: false,
            output: err instanceof Error ? err.message : String(err)
          };
          nodeResults[nodeId] = result;
          ctx.outputs[nodeId] = result.output;
          failed.add(nodeId);
        }
      })
    );
  }

  const success = failed.size === 0;
  return { success, context: ctx, nodeResults };
}

function markDescendantsSkipped(
  nodeId: string,
  outgoing: Map<string, string[]>,
  skipped: Set<string>
): void {
  if (skipped.has(nodeId)) return;
  skipped.add(nodeId);
  for (const child of outgoing.get(nodeId) ?? []) {
    markDescendantsSkipped(child, outgoing, skipped);
  }
}
