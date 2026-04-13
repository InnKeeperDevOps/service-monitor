# 2026-04-13-workflow-editor-revamp-design

## Scope
Revamp the visual Workflow Editor in the Kaiad control plane. The changes affect the visual canvas (React Flow), the node palette, the configuration side-panel, and the structure of visual nodes, without altering the underlying Domain or API types for workflows.

## Key Changes

### 1. Canvas Layout & Direction
- **Orientation:** Update nodes to use a Left-to-Right orientation instead of Top-to-Bottom.
- **Handles:** 
  - `WorkflowEventNode` (events) will have only a **Right** handle.
  - `WorkflowActionNode` (actions) and `WorkflowControlNode` (controls) will have **Left** and **Right** handles.
- **Edges:** Add directional arrows (`markerEnd` with `MarkerType.ArrowClosed`) to all edges in the canvas to clearly show execution flow.

### 2. Node Config Upgrades
- **Join Node:** Update logic to allow multiple (1...n) incoming connections, waiting for all parallel processes to finish.
- **Split Node:** Introduce or configure a split node behavior (1...n) to allow branching parallel flows.
- **Condition Fields (branchIf / if):** Introduce a dropdown or helper in the Node Config sidebar that provides available upstream variables.
  - Traverse the visual graph backwards from the selected node to identify upstream nodes.
  - Provide corresponding variables (e.g., `[nodeName].response.status` or `event.message`).
- **Loop Node:** Add support for looping over an items array, exposing the relevant item iteration variables.

### 3. Execution Engine Considerations
While this is primarily a UI revamp, the editor must successfully construct graphs that represent parallel execution flows splitting from a single node and converging at a `join` node, valid `if`/`branchIf` conditions, `loop` configurations, and `wait` logic.

**Backend Handlers Requirements:**
The backend workflow execution engine (`packages/workflow-engine/src/executor.ts` and the `handlers` logic) must be updated to fully support these control nodes:
- **`branchIf` and `if`:** Evaluate the condition using the provided upstream context variables. Based on the result, correctly branch the execution or skip descendants using `branchTaken` output.
- **`join`:** Wait until all parallel upstream processes (1...n) are complete before executing the join node itself. If upstream nodes are skipped/failed, the join logic must correctly handle or propagate the state.
- **`split`:** Explicitly handle 1...n branching for parallel flows, ensuring independent paths are dispatched effectively.
- **`loop`:** Implement iteration logic over the specified `items` array, providing the item context to the downstream actions.
- **`wait`:** Implement delay/wait logic pausing execution for a configured duration before proceeding to the next node.

*Note: Any backend engine or domain schema modifications required for split/loop/join/if/wait logic will be detailed here and implemented in tandem with the UI changes to ensure functional completeness.*

## Technical Approach

### React Flow Updates
- **`WorkflowEditorPage.tsx`:** Update `INITIAL_NODES` and `INITIAL_EDGES`. Configure default Edge options globally to include `markerEnd`.
- **Node Components:** Update `<Handle>` components in `WorkflowEventNode`, `WorkflowActionNode`, and `WorkflowControlNode` to use `Position.Left` and `Position.Right` and adjust corresponding CSS properties to align properly on the sides instead of top/bottom.

### Upstream Variable Discovery
- Implement a helper function `getUpstreamVariables(nodeId, nodes, edges)` in `workflow-sync.ts` or directly in the editor.
- The function will walk the `edges` backwards from the current node's `id` using a Breadth-First Search or Depth-First Search.
- Based on the `nodeKind` of discovered ancestors, it will append known output variables to a list.
- Pass this list to the `NodeConfigPanel` for `branchIf`, `if`, and `loop` nodes to populate an autocompletion dropdown or a clickable list next to the condition input.

### Node Config Panel Changes
- Expand the configuration fields for `loop` to include `items` (the array variable to iterate over).
- Enhance the `condition` field in the `NodeConfigPanel` to allow picking from the upstream variables list.