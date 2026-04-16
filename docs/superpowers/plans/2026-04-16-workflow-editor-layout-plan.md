# Workflow Editor IDE Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Workflow Editor page into a modern IDE-style layout with a slim header, permanent left sidebar for tools/palette, and a contextual right panel.

**Architecture:** We will modify `WorkflowEditorPage.tsx` to use a CSS grid layout (`gridTemplateColumns: "220px minmax(0, 1fr) auto"`). The top toolbar will be simplified into a header. The Palette will move to a new left sidebar. The Right panel will be conditionally rendered based on whether a node or edge is selected.

**Tech Stack:** React, React Flow, CSS inline styles.

---

### Task 1: Restructure the Grid Layout and Header

**Files:**
- Modify: `apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx`

- [ ] **Step 1: Update the main section wrapper and add the Header**
In `WorkflowEditorPage.tsx`, replace the current wrapping `<div style={{ ... }}>` and the first `<div>` (the toolbar) with a new header layout.

```tsx
// Inside the return statement of WorkflowEditorPage:
<section style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 100px)" }}>
  <div style={{ padding: "0.5rem 1rem", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: "0.5rem", background: "var(--color-surface)" }}>
    {/* Left Side: Context */}
    <span style={{ fontWeight: 600, marginRight: "1rem" }}>Workflow Editor</span>
    
    <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
      Service
      <select
        value={selectedServiceId}
        onChange={(e) => {
          setSelectedServiceId(e.target.value);
          setSelectedWorkflowId("");
        }}
        style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.2rem 0.35rem", background: "var(--color-surface)", color: "var(--color-text-primary)" }}
      >
        <option value="">{services.length === 0 ? "No services available" : "Select service"}</option>
        {services.map((svc) => (
          <option key={svc.id} value={svc.id}>{svc.name}</option>
        ))}
      </select>
    </label>
    
    <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
      Saved
      <select
        value={selectedWorkflowId}
        onChange={(e) => {
          setSelectedWorkflowId(e.target.value);
          const graph = serviceWorkflows.find((w) => w.id === e.target.value);
          if (graph) setSelectedWorkflowName(graph.name);
        }}
        disabled={serviceWorkflows.length === 0}
        style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.2rem 0.35rem", background: "var(--color-surface)", color: "var(--color-text-primary)", minWidth: 160 }}
      >
        <option value="">{serviceWorkflows.length === 0 ? "No saved workflows" : "Select workflow"}</option>
        {serviceWorkflows.map((graph) => (
          <option key={graph.id} value={graph.id}>
            {graph.name} (v{graph.version}) - {graph.id.slice(0, 8)}{selectedService?.workflowGraphId === graph.id ? " (active)" : ""}
          </option>
        ))}
      </select>
    </label>
    
    <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", color: "var(--color-text-secondary)", marginRight: "auto" }}>
      Name
      <input
        value={selectedWorkflowName}
        onChange={(e) => setSelectedWorkflowName(e.target.value)}
        placeholder="e.g. restart-app"
        style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.2rem 0.35rem", background: "var(--color-surface)", color: "var(--color-text-primary)", width: 120 }}
      />
    </label>

    {/* Right Side: Primary Actions */}
    <Button size="sm" variant="secondary" onClick={handleSetActiveWorkflow}>
      Set active
    </Button>
    <Button size="sm" onClick={handleSave} loading={saving}>
      Save Workflow
    </Button>
    <Button size="sm" variant="danger" onClick={handleExecuteOnAgent} loading={saving}>
      Queue on Agent
    </Button>
  </div>
  
  {/* Status Messages */}
  {statusMessage && (
    <div style={{ padding: "0.5rem 1rem", background: statusBgMap[statusMessage.type], color: statusColorMap[statusMessage.type], fontSize: "0.85rem", borderBottom: "1px solid var(--color-border)" }}>
      {statusMessage.text}
    </div>
  )}

  {validationErrors.length > 0 && (
    <div style={{ padding: "0.5rem 1rem", background: "var(--color-danger-bg)", fontSize: "0.85rem", borderBottom: "1px solid var(--color-border)" }}>
      <div style={{ fontWeight: 600, color: "var(--color-danger)", marginBottom: "0.25rem" }}>Validation errors:</div>
      <ul style={{ margin: 0, paddingLeft: "1.25rem", color: "var(--color-danger)" }}>
        {validationErrors.map((msg, i) => <li key={i}>{msg}</li>)}
      </ul>
    </div>
  )}

  {testRunResult && (
    <div style={{ padding: "0.5rem 1rem", background: "var(--color-info-bg)", fontSize: "0.85rem", borderBottom: "1px solid var(--color-border)" }}>
      <div style={{ fontWeight: 600, color: "var(--color-info)", marginBottom: "0.25rem" }}>Dry-run execution:</div>
      <ol style={{ margin: 0, paddingLeft: "1.25rem", color: "var(--color-info)" }}>
        {testRunResult.map((step) => (
          <li key={step.nodeId}>
            {step.success ? "PASS" : "FAIL"} {step.nodeType} ({step.nodeId})
            {step.output ? ` - ${step.output}` : ""}
          </li>
        ))}
      </ol>
    </div>
  )}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx
git commit -m "feat(workflow): extract top header and primary actions"
```

---

### Task 2: Implement the Left Sidebar and Right Contextual Panel

**Files:**
- Modify: `apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx`

- [ ] **Step 1: Setup the 3-column grid and Left Sidebar**
Right below the status messages, wrap the main editor area in a new grid. Move the secondary actions and Palette here.

```tsx
  {/* Main Editor Workspace Grid */}
  <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0, 1fr) auto", flex: 1, overflow: "hidden" }}>
    
    {/* Left Sidebar: Tools & Palette */}
    <aside style={{ borderRight: "1px solid var(--color-border)", padding: "0.75rem", overflowY: "auto", display: "flex", flexDirection: "column", gap: "1rem", background: "var(--color-surface)" }}>
      {/* Secondary Actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--color-text-secondary)", marginBottom: "0.25rem" }}>Tools</div>
        <Button size="sm" variant="secondary" onClick={handleValidate} style={{ width: "100%", justifyContent: "flex-start" }}>Validate</Button>
        <Button size="sm" variant="secondary" onClick={handleTestRun} style={{ width: "100%", justifyContent: "flex-start", color: "var(--color-info)", borderColor: "var(--color-info)" }}>Dry run</Button>
        <Button size="sm" variant="secondary" onClick={handleLoad} loading={loadingApi} style={{ width: "100%", justifyContent: "flex-start" }}>Load selected</Button>
        <Button size="sm" variant="secondary" onClick={() => void refreshWorkflows()} loading={loadingWorkflows} style={{ width: "100%", justifyContent: "flex-start" }}>Refresh list</Button>
        <Button size="sm" variant="secondary" onClick={handleToggleMode} style={{ width: "100%", justifyContent: "flex-start" }}>
          {editorMode === "visual" ? "Switch to YAML" : "Switch to Visual"}
        </Button>
        <div style={{ height: "1px", background: "var(--color-border)", margin: "0.5rem 0" }} />
        <Button size="sm" onClick={() => {
            setNodes([
              { id: "start", type: "eventNode", position: { x: 0, y: 0 }, data: { nodeType: "event", nodeKind: "agentStarted", label: "agentStarted" } },
              { id: "pull", type: "actionNode", position: { x: 0, y: 100 }, data: { nodeType: "action", nodeKind: "clone", label: "clone" } },
              { id: "build", type: "actionNode", position: { x: 0, y: 200 }, data: { nodeType: "action", nodeKind: "runShell", label: "runShell", command: "mvn clean package -DskipTests" } },
              { id: "run", type: "actionNode", position: { x: 0, y: 300 }, data: { nodeType: "action", nodeKind: "runShell", label: "runShell", command: "java -jar target/*.jar" } }
            ] as any);
            setEdges([
              { id: "e-1", source: "start", target: "pull" },
              { id: "e-2", source: "pull", target: "build" },
              { id: "e-3", source: "build", target: "run" }
            ]);
            setSelectedWorkflowName("pull-build-run");
          }} style={{ background: "purple", color: "white", width: "100%", justifyContent: "flex-start" }}>
            Auto-fill Test Flow
          </Button>
      </div>

      {/* Palette */}
      {editorMode === "visual" && (
        <div style={{ flex: 1 }}>
          <PalettePanel filter={paletteFilter} onFilterChange={setPaletteFilter} />
        </div>
      )}
    </aside>
```

- [ ] **Step 2: Setup the Center Canvas / YAML area**

```tsx
    {/* Center Workspace */}
    <div style={{ position: "relative", background: "var(--color-background)", overflow: "hidden" }}>
      {editorMode === "visual" ? (
        <div style={{ width: "100%", height: "100%" }} onDragOver={handleDragOver} onDrop={handleDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={WORKFLOW_NODE_RENDERERS}
            defaultEdgeOptions={{ type: "default", markerEnd: { type: MarkerType.ArrowClosed } }}
            onInit={setReactFlow}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onNodesDelete={handleNodesDelete}
            onEdgesDelete={handleEdgesDelete}
            onConnect={handleConnect}
            onNodeClick={handleNodeClick}
            onEdgeClick={handleEdgeClick}
            onPaneClick={handlePaneClick}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
            fitViewOptions={{ maxZoom: 1.2 }}
            snapToGrid
            snapGrid={[20, 20]}
          >
            <Background />
            <MiniMap />
            <Controls />
          </ReactFlow>
        </div>
      ) : (
        <div style={{ width: "100%", height: "100%" }}>
          <WorkflowYamlEditor 
            value={yamlContent} 
            onChange={(val) => setYamlContent(val ?? "")} 
            height="100%"
          />
        </div>
      )}
    </div>
```

- [ ] **Step 3: Setup the Contextual Right Panel**

```tsx
    {/* Contextual Right Panel */}
    {editorMode === "visual" && (selectedNode || selectedEdge) && (
      <aside
        aria-label="Configuration panel"
        style={{ width: "300px", borderLeft: "1px solid var(--color-border)", padding: "0.75rem", fontSize: "0.8rem", overflowY: "auto", background: "var(--color-surface)" }}
      >
        {selectedNode ? (
          <NodeConfigPanel
            node={selectedNode}
            nodes={nodes}
            edges={edges}
            onUpdate={updateNodeData}
            onDeleteNode={handleDeleteSelectedNode}
            onDisconnectNode={handleDisconnectSelectedNode}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : selectedEdge ? (
          <EdgeConfigPanel edge={selectedEdge} onDeleteEdge={handleDeleteSelectedEdge} onClose={() => setSelectedEdgeId(null)} />
        ) : null}
      </aside>
    )}
  </div>
</section>
```
Remove the old grid layout code and the old `<aside>` that contained the palette at the bottom of the file.

- [ ] **Step 4: Ensure H2 is removed or integrated**
Ensure the old `<h2 style={{ margin: "0 0 1rem" }}>Workflow Editor</h2>` and old wrapper divs from the top are completely removed since the header handles the title now.

- [ ] **Step 5: Run types check & Build**
Run: `pnpm --filter web typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/workflow-editor/WorkflowEditorPage.tsx
git commit -m "feat(workflow): implement 3-column IDE layout with contextual right panel"
```

---

### Task 3: Visual Verification

- [ ] **Step 1: Check UI manually or via browser tool**
Load the dev panel at `http://panel.dev.kaiad.dev`, navigate to Workflows, and confirm the new layout works.
Click on the canvas to ensure the right panel hides. Select a node to ensure it opens.

- [ ] **Step 2: Commit**
(If fixes are needed, commit them here)