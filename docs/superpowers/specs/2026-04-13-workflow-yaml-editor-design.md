# Workflow Editor YAML View

## Objective
Add a toggle in the Workflow Editor UI to switch between the existing React Flow visual graph editor and a code editor (`@monaco-editor/react`) for raw YAML editing of the workflow definition. Support generating JSON schema from our domain models to power YAML autocomplete, validation, and hover tooltips in Monaco. Saving should work seamlessly from either view.

## Scope
- Add a view toggle (Visual / YAML) to the `WorkflowEditorPage`.
- Integrate `@monaco-editor/react` in a new `WorkflowYamlEditor` component.
- Integrate `monaco-yaml` to support YAML schemas and autocomplete within Monaco.
- Add utility functions to transform between React Flow nodes/edges and the `WorkflowGraph` JSON/YAML representation.
- Configure a JSON Schema for the `WorkflowGraph` using `zod-to-json-schema` to generate it automatically from `@sm/domain/src/workflow.ts` or hardcode a static schema if simpler.
- Handle state syncing between the Visual and YAML views (e.g., when toggling, serialize visual state to YAML or parse YAML back to visual state).

## Architecture

### 1. View Toggle
The `WorkflowEditorPage` will manage a new piece of state: `editorMode: "visual" | "yaml"`.
A simple button group or switch in the header toolbar will allow the user to toggle this state.

### 2. State Management & Syncing
- **Visual -> YAML**: When switching from Visual to YAML, the current `nodes` and `edges` (from React Flow) are converted into a `WorkflowGraph` object (`toWorkflowNodes` / `toWorkflowEdges`) and then serialized to a YAML string using the `yaml` package (`yaml.stringify`).
- **YAML -> Visual**: When switching from YAML to Visual, the YAML string is parsed (`yaml.parse`). If it's valid, the resulting `WorkflowGraph` nodes and edges are mapped back to React Flow's `WorkflowEditorNode` and `Edge` objects. If parsing fails, we show an error and prevent switching views until the YAML is valid.
- **Saving**: The `handleSave` function will serialize the current active view. If in Visual mode, it saves from `nodes` and `edges`. If in YAML mode, it parses the YAML string and saves that.

### 3. Monaco Editor Integration
We will add two dependencies to `apps/web/package.json`:
- `@monaco-editor/react`: The React wrapper for Monaco.
- `monaco-yaml`: A plugin for Monaco to provide YAML language support, JSON Schema validation, and autocomplete.
- `yaml`: For parsing and stringifying YAML.

We will create a new component `WorkflowYamlEditor.tsx` that configures Monaco with `monaco-yaml`. It will take a `value` (the YAML string) and `onChange` callback.

### 4. JSON Schema Generation
To power Monaco's autocomplete and validation, we need a JSON Schema representing our `WorkflowGraph`.
We can use `zod-to-json-schema` to generate this schema directly from `workflowGraphNodeSchema` and `workflowGraphEdgeSchema` in `@sm/contracts`, or manually define a simple JSON Schema that covers the structure. We'll generate it to ensure it stays in sync with our actual domain types.

## Dependencies to Add
```bash
cd apps/web
pnpm add @monaco-editor/react monaco-yaml yaml
pnpm add -D zod-to-json-schema
```

## Potential Risks / Trade-offs
- **Bundle Size**: Monaco is a large dependency. Since this is an admin dashboard, it is an acceptable trade-off for a significantly better UX with autocomplete and validation. We will ensure Monaco is lazily loaded (which `@monaco-editor/react` does by default via CDN, or can be bundled).
- **Position Data**: The YAML representation will include `position: { x, y }` for nodes. While users don't need to manually type these, they are required for the visual editor. If a user creates a new node in YAML without coordinates, the YAML -> Visual converter will need to auto-layout the new nodes (e.g., assign them default positions based on their index) so they don't all stack at `(0,0)`.
- **Validation on Switch**: If the user writes invalid YAML (syntax error or fails Zod validation), they cannot switch back to the Visual view. We must clearly surface the parse/validation error.

## Implementation Steps
1. Install new dependencies in `apps/web`.
2. Create JSON Schema definition for Monaco (using `zod-to-json-schema`).
3. Create `WorkflowYamlEditor` component wrapping `@monaco-editor/react` and configuring `monaco-yaml` with the schema.
4. Add `editorMode` toggle in `WorkflowEditorPage`.
5. Implement conversion functions (Visual -> YAML string, YAML string -> Visual).
6. Update the `handleSave`, `handleTestRun`, and `handleExecuteOnAgent` functions to respect the current active editor mode.
