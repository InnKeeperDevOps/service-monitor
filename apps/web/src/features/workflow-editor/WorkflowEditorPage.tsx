import { useState, useEffect, useCallback, useRef, type DragEvent } from "react";
import {
  WORKFLOW_TRIGGER_TYPES,
  validateWorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeType
} from "@sm/domain";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type WorkflowGraph, type MonitoredService } from "../../lib/api.js";
import { Button } from "../../components/Button.js";
import { Input } from "../../components/Input.js";

const MVP_PALETTE: { title: string; types: readonly WorkflowNodeType[] }[] = [
  { title: "Triggers", types: WORKFLOW_TRIGGER_TYPES },
  {
    title: "Actions",
    types: [
      "runCursorPlan",
      "runClaudePlan",
      "dockerRun",
      "dockerBuild",
      "runShell",
      "composeUp",
      "composeDown"
    ]
  },
  { title: "Control", types: ["branchIf", "join", "wait", "setEnv", "injectSecret", "template"] },
  {
    title: "Integration",
    types: [
      "httpRequest",
      "slackNotify",
      "emailNotify",
      "genericWebhook",
      "clone",
      "checkoutBranch",
      "createPR",
      "mergePR",
      "push",
      "dispatchWorkflow"
    ]
  }
];

const DEFERRED_PALETTE: { title: string; types: string[] }[] = [
  { title: "Triggers (coming soon)", types: ["onGitHubEvent", "onHealthCheckFailed", "onContainerExit", "onIncidentOpened", "onIncidentResolved", "onAgentOnline", "onAgentOffline"] },
  { title: "Actions (coming soon)", types: ["teamsNotify", "discordWebhook", "createIncident", "updateIncident", "requestApproval", "uploadArtifact"] }
];

const INITIAL_NODES: Node[] = [
  { id: "t1", position: { x: 0, y: 120 }, data: { label: "onCrash" }, type: "input" },
  { id: "br", position: { x: 200, y: 120 }, data: { label: "branchIf" } },
  { id: "p1", position: { x: 420, y: 40 }, data: { label: "runCursorPlan" } },
  { id: "p2", position: { x: 420, y: 200 }, data: { label: "runClaudePlan" } },
  { id: "jn", position: { x: 640, y: 120 }, data: { label: "join" } },
  { id: "sl", position: { x: 860, y: 120 }, data: { label: "slackNotify" }, type: "output" }
];

const INITIAL_EDGES: Edge[] = [
  { id: "e0", source: "t1", target: "br" },
  { id: "e1", source: "br", target: "p1" },
  { id: "e2", source: "br", target: "p2" },
  { id: "e3", source: "p1", target: "jn" },
  { id: "e4", source: "p2", target: "jn" },
  { id: "e5", source: "jn", target: "sl" }
];

const TRIGGER_TYPES = new Set<string>(WORKFLOW_TRIGGER_TYPES);

function toWorkflowNodes(nodes: Node[]): WorkflowNode[] {
  return nodes.map((n) => ({
    id: n.id,
    type: String(n.data.label) as WorkflowNodeType,
  }));
}

function toWorkflowEdges(edges: Edge[]) {
  return edges.map((e) => ({ from: e.source, to: e.target }));
}

export function WorkflowEditorPage() {
  const [nodes, setNodes] = useState<Node[]>(INITIAL_NODES);
  const [edges, setEdges] = useState<Edge[]>(INITIAL_EDGES);
  const [saving, setSaving] = useState(false);
  const [loadingApi, setLoadingApi] = useState(false);
  const [services, setServices] = useState<MonitoredService[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [testRunResult, setTestRunResult] = useState<string[] | null>(null);
  const [paletteFilter, setPaletteFilter] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null;

  useEffect(() => {
    api
      .listServices()
      .then((res) => {
        setServices(res.services);
        setSelectedServiceId((prev) => prev || res.services[0]?.id || "");
      })
      .catch(() => {
        setServices([]);
        setSelectedServiceId("");
      });
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedServiceId) {
      setStatusMessage({ type: "error", text: "Select a service before saving workflow" });
      return;
    }
    setSaving(true);
    setStatusMessage(null);
    setValidationErrors([]);
    try {
      await api.createWorkflow({
        serviceId: selectedServiceId,
        nodes: toWorkflowNodes(nodes),
        edges: toWorkflowEdges(edges),
      });
      setStatusMessage({ type: "success", text: "Workflow saved successfully" });
    } catch (err) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [nodes, edges, selectedServiceId]);

  const handleLoad = useCallback(async () => {
    setLoadingApi(true);
    setStatusMessage(null);
    setValidationErrors([]);
    try {
      const res = await api.listWorkflows();
      if (res.graphs.length === 0) {
        setStatusMessage({ type: "info", text: "No saved workflows found" });
        return;
      }
      const graph = res.graphs[0] as WorkflowGraph;
      setNodes(
        graph.nodes.map((n, i) => ({
          id: n.id,
          position: { x: i * 200, y: 120 },
          data: { label: n.type },
          ...(i === 0 ? { type: "input" as const } : {}),
          ...(i === graph.nodes.length - 1 ? { type: "output" as const } : {}),
        }))
      );
      setEdges(
        graph.edges.map((e, i) => ({
          id: `e${i}`,
          source: e.from,
          target: e.to,
        }))
      );
      setStatusMessage({ type: "success", text: `Loaded workflow (${graph.nodes.length} nodes)` });
    } catch (err) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    } finally {
      setLoadingApi(false);
    }
  }, []);

  const handleValidate = useCallback(() => {
    setStatusMessage(null);
    const errors = validateWorkflowGraph(
      toWorkflowNodes(nodes),
      toWorkflowEdges(edges),
    );
    if (errors.length === 0) {
      setValidationErrors([]);
      setStatusMessage({ type: "success", text: "Workflow graph is valid" });
    } else {
      setValidationErrors(errors.map((e) => e.message));
    }
  }, [nodes, edges]);

  const handleTestRun = useCallback(() => {
    setStatusMessage(null);
    setTestRunResult(null);
    setValidationErrors([]);
    const errors = validateWorkflowGraph(
      toWorkflowNodes(nodes),
      toWorkflowEdges(edges),
    );
    if (errors.length > 0) {
      setValidationErrors(errors.map((e) => e.message));
      return;
    }
    const stepLabels = nodes.map((n) => `✓ ${String(n.data.label)}`);
    setTestRunResult(stepLabels);
    setStatusMessage({ type: "info", text: "Test run complete — simulated execution below" });
  }, [nodes, edges]);

  const handleExecuteOnAgent = useCallback(async () => {
    if (!selectedServiceId) {
      setStatusMessage({ type: "error", text: "Select a service before executing workflow" });
      return;
    }
    setSaving(true);
    setStatusMessage(null);
    setValidationErrors([]);
    try {
      const execution = await api.executeWorkflow({
        serviceId: selectedServiceId,
        nodes: toWorkflowNodes(nodes),
        edges: toWorkflowEdges(edges),
      });
      setStatusMessage({
        type: "success",
        text: `Workflow v${execution.workflowVersion} saved; dispatch state is ${execution.dispatchState} for agent ${execution.agentId} (command ${execution.commandId})`
      });
    } catch (err) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [nodes, edges, selectedServiceId]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const nodeType = e.dataTransfer.getData("application/reactflow");
      if (!nodeType) return;

      const bounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!bounds) return;

      const position = {
        x: e.clientX - bounds.left,
        y: e.clientY - bounds.top,
      };

      const newId = `node_${Date.now()}`;
      const newNode: Node = {
        id: newId,
        position,
        data: { label: nodeType },
      };

      setNodes((prev) => [...prev, newNode]);
    },
    []
  );

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const updateNodeData = useCallback((nodeId: string, key: string, value: string) => {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, [key]: value } } : n
      )
    );
  }, []);

  const statusColorMap = { success: "var(--color-success)", error: "var(--color-danger)", info: "var(--color-info)" };
  const statusBgMap = { success: "var(--color-success-bg)", error: "var(--color-danger-bg)", info: "var(--color-info-bg)" };

  const isTrigger = selectedNode ? TRIGGER_TYPES.has(String(selectedNode.data.label)) : false;

  return (
    <section>
      <h2 style={{ margin: "0 0 1rem" }}>Workflow Editor (MVP)</h2>
      <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12 }}>
        <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)", marginRight: "auto" }}>
            Sample graph: trigger → branchIf → parallel plans → join → slack
          </span>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
            Service
            <select
              value={selectedServiceId}
              onChange={(e) => setSelectedServiceId(e.target.value)}
              style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.2rem 0.35rem", background: "var(--color-surface)", color: "var(--color-text-primary)" }}
            >
              <option value="">{services.length === 0 ? "No services available" : "Select service"}</option>
              {services.map((svc) => (
                <option key={svc.id} value={svc.id}>
                  {svc.name}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="secondary" onClick={handleValidate}>
            Validate
          </Button>
          <Button size="sm" variant="secondary" onClick={handleLoad} loading={loadingApi}>
            Load from API
          </Button>
          <Button size="sm" onClick={handleSave} loading={saving}>
            Save Workflow
          </Button>
          <Button size="sm" variant="secondary" onClick={handleTestRun} style={{ background: "var(--color-info)", color: "var(--color-primary-foreground)", borderColor: "var(--color-info)" }}>
            Validate / Test Run
          </Button>
          <Button size="sm" variant="danger" onClick={handleExecuteOnAgent} loading={saving}>
            Queue on Agent
          </Button>
        </div>

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
            <div style={{ fontWeight: 600, color: "var(--color-info)", marginBottom: "0.25rem" }}>Simulated step execution:</div>
            <ol style={{ margin: 0, paddingLeft: "1.25rem", color: "var(--color-info)" }}>
              {testRunResult.map((step, i) => <li key={i}>{step}</li>)}
            </ol>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 220px" }}>
          <div ref={reactFlowWrapper} style={{ height: 360 }} onDragOver={handleDragOver} onDrop={handleDrop}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={(changes) => setNodes((nds) => {
                const updated = [...nds];
                for (const change of changes) {
                  if (change.type === "position" && change.position) {
                    const idx = updated.findIndex((n) => n.id === change.id);
                    if (idx >= 0) updated[idx] = { ...updated[idx], position: change.position };
                  }
                }
                return updated;
              })}
              onNodeClick={handleNodeClick}
              onPaneClick={handlePaneClick}
              fitView
            >
              <Background />
              <MiniMap />
              <Controls />
            </ReactFlow>
          </div>

          <aside
            aria-label="Side panel"
            style={{ borderLeft: "1px solid var(--color-border)", padding: "0.75rem", fontSize: "0.8rem", overflow: "auto", maxHeight: 360 }}
          >
            {selectedNode ? (
              <NodeConfigPanel
                node={selectedNode}
                isTrigger={isTrigger}
                onUpdate={updateNodeData}
                onClose={() => setSelectedNodeId(null)}
              />
            ) : (
              <PalettePanel filter={paletteFilter} onFilterChange={setPaletteFilter} />
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}

function NodeConfigPanel({
  node,
  isTrigger,
  onUpdate,
  onClose,
}: {
  node: Node;
  isTrigger: boolean;
  onUpdate: (nodeId: string, key: string, value: string) => void;
  onClose: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <div style={{ fontWeight: 600 }}>Node Config</div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          ✕
        </Button>
      </div>
      <div style={{ marginBottom: "0.5rem", color: "var(--color-text-secondary)", fontSize: "0.75rem" }}>
        ID: {node.id}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <Input
          label="Label"
          value={String(node.data.label ?? "")}
          onChange={(e) => onUpdate(node.id, "label", e.target.value)}
        />
        {isTrigger && (
          <Input
            label="Filter"
            placeholder="e.g. severity=critical"
            value={String(node.data.filter ?? "")}
            onChange={(e) => onUpdate(node.id, "filter", e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

function PalettePanel({
  filter,
  onFilterChange,
}: {
  filter: string;
  onFilterChange: (v: string) => void;
}) {
  function handleDragStart(e: DragEvent<HTMLLIElement>, nodeType: string) {
    e.dataTransfer.setData("application/reactflow", nodeType);
    e.dataTransfer.effectAllowed = "move";
  }

  return (
    <>
      <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>MVP node palette</div>
      <input
        type="text"
        placeholder="Search nodes..."
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
        style={{ width: "100%", padding: "0.3rem", marginBottom: "0.5rem", border: "1px solid var(--color-border)", borderRadius: 4, fontSize: "0.8rem", boxSizing: "border-box" }}
      />
      {MVP_PALETTE.map((group) => {
        const filtered = group.types.filter(t => t.toLowerCase().includes(filter.toLowerCase()));
        if (filtered.length === 0) return null;
        return (
          <div key={group.title} style={{ marginBottom: "0.65rem" }}>
            <div style={{ color: "var(--color-text-secondary)", marginBottom: "0.2rem" }}>{group.title}</div>
            <ul style={{ margin: 0, paddingLeft: "1rem", lineHeight: 1.45 }}>
              {filtered.map((t) => (
                <li
                  key={t}
                  draggable
                  onDragStart={(e) => handleDragStart(e, t)}
                  style={{ cursor: "grab" }}
                >
                  {t}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {DEFERRED_PALETTE.map((group) => {
        const filtered = group.types.filter(t => t.toLowerCase().includes(filter.toLowerCase()));
        if (filtered.length === 0) return null;
        return (
          <div key={group.title} style={{ marginBottom: "0.65rem", opacity: 0.5 }}>
            <div style={{ color: "var(--color-text-muted)", marginBottom: "0.2rem", fontSize: "0.75rem" }}>{group.title}</div>
            <ul style={{ margin: 0, paddingLeft: "1rem", lineHeight: 1.45, color: "var(--color-text-muted)" }}>
              {filtered.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </div>
        );
      })}
    </>
  );
}
