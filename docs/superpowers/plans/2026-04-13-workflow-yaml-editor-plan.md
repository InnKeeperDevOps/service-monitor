# Workflow YAML Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggle in the Workflow Editor UI to switch between the existing React Flow visual editor and a Monaco-based YAML editor with autocomplete.

**Architecture:** We will use `@monaco-editor/react`, `monaco-yaml`, and `yaml` to provide a rich text editing experience. We'll use `zod-to-json-schema` to convert our existing Zod schemas from `@sm/contracts` into JSON Schema to power Monaco's autocomplete and validation. We will add a simple toggle button in `WorkflowEditorPage` to switch between modes, and sync state by serializing to/from YAML on switch and on save.

**Tech Stack:** React, `@monaco-editor/react`, `monaco-yaml`, `yaml`, `zod-to-json-schema`

---

### Task 1: Dependencies and Schema Utility

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/features/workflow-editor/workflowSchema.ts`

- [ ] **Step 1: Install dependencies**

```bash
cd apps/web
pnpm add @monaco-editor/react monaco-yaml yaml zod-to-json-schema
```

- [ ] **Step 2: Create schema generation utility**

Create `apps/web/src/features/workflow-editor/workflowSchema.ts` to export the JSON schema generated from our Zod contracts.

```typescript
import { zodToJsonSchema } from "zod-to-json-schema";
import { workflowGraphSchema } from "@sm/contracts";

// Generate JSON Schema from Zod schema
export const workflowJsonSchema = zodToJsonSchema(workflowGraphSchema, "WorkflowGraph");
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml apps/web/src/features/workflow-editor/workflowSchema.ts
git commit -m "feat: add deps and schema utility for yaml editor"
```

### Task 2: Create WorkflowYamlEditor Component

**Files:**
- Create: `apps/web/src/features/workflow-editor/WorkflowYamlEditor.tsx`

- [ ] **Step 1: Create the editor component**

Create `apps/web/src/features/workflow-editor/WorkflowYamlEditor.tsx`. This component wraps Monaco and configures `monaco-yaml`.

```tsx
import { useEffect } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";
import { configureMonacoYaml } from "monaco-yaml";
import { workflowJsonSchema } from "./workflowSchema.js";

interface WorkflowYamlEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  height?: string;
}

export function WorkflowYamlEditor({ value, onChange, height = "400px" }: WorkflowYamlEditorProps) {
  const monaco = useMonaco();

  useEffect(() => {
    if (monaco) {
      configureMonacoYaml(monaco, {
        enableSchemaRequest: false,
        schemas: [
          {
            uri: "http://internal/workflow-schema.json",
            fileMatch: ["*"], // Apply to all files in this Monaco instance
            schema: workflowJsonSchema as any,
          },
        ],
      });
    }
  }, [monaco]);

  return (
    <Editor
      height={height}
      defaultLanguage="yaml"
      theme="vs-dark" // or vs-light based on your app's theme
      value={value}
      onChange={onChange}
      options={{
        minimap: { enabled: false },
        tabSize: 2,
        scrollBeyondLastLine: false,
        wordWrap: "on",
      }}
    />
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/features/workflow-editor/WorkflowYamlEditor.tsx
git commit -m "feat: add WorkflowYamlEditor component"
```

### Task 3: Update WorkflowEditorPage

**Files:**
- Modify: `apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx`

- [ ] **Step 1: Import new dependencies and add state**

Open `apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx`.

Add imports at the top:
```tsx
import * as yaml from "yaml";
import { WorkflowYamlEditor } from "./WorkflowYamlEditor.js";
import { workflowGraphSchema } from "@sm/contracts";
```

Add new state inside `WorkflowEditorPage`:
```tsx
  const [editorMode, setEditorMode] = useState<"visual" | "yaml">("visual");
  const [yamlContent, setYamlContent] = useState<string>("");
```

- [ ] **Step 2: Add toggle logic and sync functions**

Add functions to sync state when switching modes inside `WorkflowEditorPage`:

```tsx
  const handleToggleMode = () => {
    if (editorMode === "visual") {
      // Sync Visual -> YAML
      const graphObj = {
        name: selectedWorkflowName || "Untitled Workflow",
        nodes: toWorkflowNodes(nodes),
        edges: toWorkflowEdges(edges),
      };
      setYamlContent(yaml.stringify(graphObj));
      setEditorMode("yaml");
    } else {
      // Sync YAML -> Visual
      try {
        const parsed = yaml.parse(yamlContent);
        // Basic validation using Zod (optional, could just check shape)
        const result = workflowGraphSchema.pick({ nodes: true, edges: true }).safeParse(parsed);
        
        if (!result.success) {
          setStatusMessage({ type: "error", text: "Invalid YAML structure. Please fix errors before switching." });
          return;
        }

        // Map back to React Flow nodes
        setNodes(
          result.data.nodes.map((n: any, i: number) => {
            const nodeType = n.type;
            const nodeKind = n.kind || "runShell";
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
          })
        );
        
        setEdges(
          result.data.edges.map((e: any, i: number) => ({
            id: `e${i}`,
            source: e.from,
            target: e.to,
          }))
        );

        setStatusMessage(null);
        setEditorMode("visual");
      } catch (err) {
        setStatusMessage({ type: "error", text: `YAML Parse Error: ${(err as Error).message}` });
      }
    }
  };
```

- [ ] **Step 3: Update `handleSave`, `handleTestRun`, and `handleExecuteOnAgent`**

In `handleSave`, `handleTestRun`, and `handleExecuteOnAgent`, read from `yamlContent` if `editorMode === "yaml"`.
Example for `handleSave`:

```tsx
  const handleSave = useCallback(async () => {
    if (!selectedServiceId) {
      setStatusMessage({ type: "error", text: "Select a service before saving workflow" });
      return;
    }
    setSaving(true);
    setStatusMessage(null);
    setValidationErrors([]);
    try {
      let payloadNodes, payloadEdges;

      if (editorMode === "yaml") {
        const parsed = yaml.parse(yamlContent);
        payloadNodes = parsed.nodes || [];
        payloadEdges = parsed.edges || [];
      } else {
        payloadNodes = toWorkflowNodes(nodes);
        payloadEdges = toWorkflowEdges(edges);
      }

      const graph = await api.createWorkflow({
        name: selectedWorkflowName || "Untitled Workflow",
        nodes: payloadNodes,
        edges: payloadEdges,
      });
      // ... rest of handleSave
```
*(Apply similar logic for `handleTestRun` and `handleExecuteOnAgent` to use `yamlContent` when in `yaml` mode)*

- [ ] **Step 4: Render the Toggle and Editor UI**

In the toolbar (next to "Auto-fill Test Workflow"), add the toggle button:
```tsx
          <Button size="sm" variant="secondary" onClick={handleToggleMode}>
            {editorMode === "visual" ? "Switch to YAML" : "Switch to Visual"}
          </Button>
```

In the main layout area (replacing the grid with ReactFlow), conditionally render the YAML editor:

```tsx
        {editorMode === "visual" ? (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 220px" }}>
            <div style={{ height: 360 }} onDragOver={handleDragOver} onDrop={handleDrop}>
              <ReactFlow ... />
            </div>
            <aside ...>
               {/* Panels */}
            </aside>
          </div>
        ) : (
          <div style={{ height: 360, borderTop: "1px solid var(--color-border)" }}>
            <WorkflowYamlEditor 
              value={yamlContent} 
              onChange={(val) => setYamlContent(val ?? "")} 
              height="360px"
            />
          </div>
        )}
```

- [ ] **Step 5: Verify using typecheck and UI testing**

```bash
cd apps/web && pnpm typecheck
```
Then test loading `http://panel.dev.kaiad.dev`, navigating to Workflows, toggling to YAML, making an edit, toggling back, and saving.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx
git commit -m "feat: integrate yaml editor toggle and sync logic"
```
