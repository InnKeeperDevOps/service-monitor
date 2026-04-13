# Workflow Editor Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revamp the visual Workflow Editor in the Kaiad control plane to use a left-to-right orientation, add directional arrows, provide an upstream variable selector for condition nodes, and implement the necessary backend engine handlers for complex control flow (join, split, branchIf, if, loop, wait).

**Architecture:** Update the React Flow configuration in the web app to use `Position.Left`/`Position.Right` and `MarkerType.ArrowClosed`. Add a graph traversal utility in `workflow-sync.ts` to identify upstream node variables. Update the workflow execution engine and server handler registrations to execute complex control nodes appropriately.

**Tech Stack:** React, React Flow, TypeScript, Fastify, Drizzle ORM (backend).

---

### Task 1: Update Node Handles and Edge Markers

**Files:**
- Modify: `apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx`

- [ ] **Step 1: Update Node Handle Positions**
In `WorkflowEventNode`, `WorkflowActionNode`, and `WorkflowControlNode`:
Change `Position.Top` to `Position.Left` and `Position.Bottom` to `Position.Right`. Remove the target (Left) handle for `WorkflowEventNode` completely, as it should only output.

- [ ] **Step 2: Update Edge Arrows**
In `WorkflowEditorPage`, when passing `edges` to `<ReactFlow>`, ensure they have `markerEnd`.
Change `INITIAL_EDGES` to include: `markerEnd: { type: MarkerType.ArrowClosed }` for each.
Change `handleConnect` to include: `markerEnd: { type: MarkerType.ArrowClosed }` when adding a new edge.

- [ ] **Step 3: Update Initial Node Positions**
Adjust the `x` and `y` coordinates in `INITIAL_NODES` to reflect a left-to-right spread (e.g. increasing `x` significantly instead of `y`).

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx
git commit -m "feat(ui): update node handles to left-to-right with directional edges"
```

### Task 2: Upstream Variable Discovery Utility

**Files:**
- Modify: `apps/web/src/features/workflow-editor/workflow-sync.ts`
- Modify: `apps/web/test/workflow-sync.test.ts` (create if needed)

- [ ] **Step 1: Write `getUpstreamVariables` failing test**
```typescript
// apps/web/test/workflow-sync.test.ts
import { getUpstreamVariables } from "../src/features/workflow-editor/workflow-sync.js";

describe("getUpstreamVariables", () => {
  it("should return variables from upstream nodes", () => {
    const nodes = [
      { id: "n1", data: { nodeKind: "httpRequest", label: "req" } },
      { id: "n2", data: { nodeKind: "branchIf" } }
    ] as any;
    const edges = [{ source: "n1", target: "n2" }] as any;
    const vars = getUpstreamVariables("n2", nodes, edges);
    expect(vars).toContain("req.response.status");
  });
});
```

- [ ] **Step 2: Implement `getUpstreamVariables`**
```typescript
// apps/web/src/features/workflow-editor/workflow-sync.ts
export function getUpstreamVariables(nodeId: string, nodes: WorkflowEditorNode[], edges: Edge[]): string[] {
  const vars: string[] = [];
  const visited = new Set<string>();
  const queue = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const incomingEdges = edges.filter(e => e.target === current);
    for (const edge of incomingEdges) {
      const sourceNode = nodes.find(n => n.id === edge.source);
      if (sourceNode && !visited.has(sourceNode.id)) {
        queue.push(sourceNode.id);
        const label = sourceNode.data.label || sourceNode.data.nodeKind;
        if (sourceNode.data.nodeKind === "httpRequest") {
          vars.push(`${label}.response.status`, `${label}.response.body`);
        } else if (sourceNode.data.nodeType === "event") {
          vars.push(`event.message`, `event.severity`, `event.container_id`);
        }
      }
    }
  }
  return [...new Set(vars)];
}
```

- [ ] **Step 3: Run the test to pass**
```bash
npx vitest run apps/web/test/workflow-sync.test.ts
```

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/features/workflow-editor/workflow-sync.ts apps/web/test/workflow-sync.test.ts
git commit -m "feat(ui): add getUpstreamVariables utility for workflow editor"
```

### Task 3: Node Config Panel Condition Builder & Loop Support

**Files:**
- Modify: `apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx`

- [ ] **Step 1: Implement Variable Dropdown in `NodeConfigPanel`**
Import `getUpstreamVariables` into `WorkflowEditorPage.tsx`. Pass `nodes` and `edges` to `NodeConfigPanel`.
For `nodeKind === "branchIf" || nodeKind === "if" || nodeKind === "loop"`, render a `select` dropdown or a list of clickable variable badges using `getUpstreamVariables(node.id, nodes, edges)` below the condition input field to append the variable.

- [ ] **Step 2: Implement Loop Items Field**
In `NodeConfigPanel`, add an input field for `node.data.items` if `nodeKind === "loop"`.

- [ ] **Step 3: Verify visually in dev environment**
Since this is UI, rely on the dev server. No strict test file is required if E2E isn't available for this specific panel, but ensure TypeScript compiles.
```bash
pnpm --filter web build
```

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx
git commit -m "feat(ui): add variable selector and loop items to node config panel"
```

### Task 4: Backend Execution Engine - Handlers Update

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `packages/workflow-engine/src/executor.ts` (if needed for split)
- Modify: `packages/domain/src/workflow.ts` (ensure `items` exists on loop node schema if necessary)

- [ ] **Step 1: Check and Update Domain Schema**
In `packages/domain/src/workflow.ts`, ensure the Zod schema for `loop` allows an `items` string.
```typescript
// Example update to control schema
items: z.string().optional()
```

- [ ] **Step 2: Update Server Handlers**
In `apps/api/src/server.ts`, within the `executeWorkflow` initialization block (around `handlers` map):
Add handlers for `loop`, `if`, `split`, and `wait` alongside `branchIf` and `join`.
```typescript
if (node.kind === "if") {
  // Evaluate condition, set branchTaken true/false but only 1 target
}
if (node.kind === "loop") {
  // Handle iteration logic over node.data.items array reference
}
if (node.kind === "wait") {
  // await a setTimeout based on node.data.duration
}
if (node.kind === "join") {
  // Join already waits for upstream, just return success
  return { success: true };
}
```

- [ ] **Step 3: Update Executor logic for Join/Split**
In `packages/workflow-engine/src/executor.ts`, ensure `split` triggers all targets (default behavior of `executeWorkflow` is to trigger all outgoing edges, so `split` might just need a basic handler returning success).
Ensure `join` correctly waits for all incoming active paths (already partially handled by `allIncomingFailed` checks, but needs to make sure it doesn't fire prematurely if some parallel branches are still running - topological sort guarantees this).

- [ ] **Step 4: Run Tests**
```bash
pnpm --filter api test
```

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/server.ts packages/workflow-engine/src/executor.ts packages/domain/src/workflow.ts
git commit -m "feat(backend): implement missing control node handlers (join, loop, if, wait, split)"
```
