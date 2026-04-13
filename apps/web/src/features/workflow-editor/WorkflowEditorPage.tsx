import { useState, useEffect, useCallback, useMemo, type DragEvent } from "react";
import { WorkflowYamlEditor } from "./WorkflowYamlEditor.js";
import {
  WORKFLOW_ACTION_KINDS,
  WORKFLOW_CONTROL_KINDS,
  WORKFLOW_EVENT_KINDS,
  WORKFLOW_NODE_TYPES,
  validateWorkflowGraph,
  type WorkflowNodeKind,
  type WorkflowNodeType
} from "@sm/domain";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type WorkflowGraph, type MonitoredService } from "../../lib/api.js";
import { Button } from "../../components/Button.js";
import { Input } from "../../components/Input.js";
import {
  type WorkflowEditorNode,
  type WorkflowEditorNodeData,
  type WorkflowEditorVisualType,
  isWorkflowNodeKind,
  resolveNodeTypeFromKind,
  resolveVisualType,
  sanitizeDataForNode,
  getNodeLabel,
  visualToYaml,
  yamlToVisual,
  getActivePayload,
  toDomainNodes,
} from "./workflow-sync.js";

const MVP_PALETTE = [
  { title: "Events", types: WORKFLOW_EVENT_KINDS },
  { title: "Control", types: WORKFLOW_CONTROL_KINDS },
  { title: "Actions", types: WORKFLOW_ACTION_KINDS }
];

const DEFERRED_PALETTE = [
  { title: "Triggers (coming soon)", types: ["onGitHubEvent", "onHealthCheckFailed", "onContainerExit", "onIncidentOpened", "onIncidentResolved", "onAgentOnline", "onAgentOffline"] },
  { title: "Actions (coming soon)", types: ["teamsNotify", "discordWebhook", "createIncident", "updateIncident", "requestApproval", "uploadArtifact"] }
];

const INITIAL_EDGES: Edge[] = [
  { id: "e0", source: "t1", target: "br" },
  { id: "e1", source: "br", target: "p1" },
  { id: "e2", source: "br", target: "p2" },
  { id: "e3", source: "p1", target: "jn" },
  { id: "e4", source: "p2", target: "jn" },
  { id: "e5", source: "jn", target: "sl" }
];

const INITIAL_NODES: WorkflowEditorNode[] = [
  { id: "t1", type: resolveVisualType("event"), position: { x: 0, y: 120 }, data: { nodeType: "event", nodeKind: "onCrash", label: "onCrash" } },
  { id: "br", type: resolveVisualType("control"), position: { x: 220, y: 120 }, data: { nodeType: "control", nodeKind: "branchIf", label: "branchIf", condition: "severity=critical" } },
  { id: "p1", type: resolveVisualType("action"), position: { x: 460, y: 30 }, data: { nodeType: "action", nodeKind: "runCursorPlan", label: "runCursorPlan" } },
  { id: "p2", type: resolveVisualType("action"), position: { x: 460, y: 220 }, data: { nodeType: "action", nodeKind: "runClaudePlan", label: "runClaudePlan" } },
  { id: "jn", type: resolveVisualType("control"), position: { x: 700, y: 120 }, data: { nodeType: "control", nodeKind: "join", label: "join" } },
  { id: "sl", type: resolveVisualType("action"), position: { x: 920, y: 120 }, data: { nodeType: "action", nodeKind: "slackNotify", label: "slackNotify", channel: "#alerts" } }
];

export function WorkflowEditorPage() {
  const [editorMode, setEditorMode] = useState<"visual" | "yaml">("visual");
  const [yamlContent, setYamlContent] = useState<string>("");
  const [nodes, setNodes] = useState<WorkflowEditorNode[]>(INITIAL_NODES);
  const [edges, setEdges] = useState<Edge[]>(INITIAL_EDGES);
  const [saving, setSaving] = useState(false);
  const [loadingApi, setLoadingApi] = useState(false);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [services, setServices] = useState<MonitoredService[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowGraph[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [selectedWorkflowName, setSelectedWorkflowName] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [testRunResult, setTestRunResult] = useState<{ nodeId: string; nodeType: string; success: boolean; output?: string }[] | null>(null);
  const [paletteFilter, setPaletteFilter] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<WorkflowEditorNode, Edge> | null>(null);

  const handleToggleMode = () => {
    if (editorMode === "visual") {
      setYamlContent(visualToYaml(selectedWorkflowName || "Untitled Workflow", nodes, edges));
      setEditorMode("yaml");
    } else {
      try {
        const { name, nodes: newNodes, edges: newEdges } = yamlToVisual(yamlContent);
        if (name) {
          setSelectedWorkflowName(name);
        }
        setNodes(newNodes);
        setEdges(newEdges);
        setStatusMessage(null);
        setEditorMode("visual");
      } catch (err) {
        setStatusMessage({ type: "error", text: (err as Error).message });
      }
    }
  };

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? edges.find((e) => e.id === selectedEdgeId) ?? null : null;
  const selectedService = services.find((svc) => svc.id === selectedServiceId);
  const serviceWorkflows = useMemo(() => {
    return workflows
      .filter((graph) => graph.serviceId === selectedServiceId)
      .sort((a, b) => b.version - a.version);
  }, [workflows, selectedServiceId]);

  const refreshWorkflows = useCallback(async () => {
    setLoadingWorkflows(true);
    try {
      const res = await api.listWorkflows();
      setWorkflows(res.graphs);
    } catch {
      setWorkflows([]);
    } finally {
      setLoadingWorkflows(false);
    }
  }, []);

  const refreshServices = useCallback(async () => {
    try {
      const res = await api.listServices();
      setServices(res.services);
      setSelectedServiceId((prev) => prev || res.services[0]?.id || "");
    } catch {
      setServices([]);
      setSelectedServiceId("");
    }
  }, []);

  useEffect(() => {
    void refreshServices();
    void refreshWorkflows();
  }, [refreshServices, refreshWorkflows]);

  useEffect(() => {
    if (!selectedServiceId) {
      setSelectedWorkflowId("");
      return;
    }
    if (serviceWorkflows.length === 0) {
      setSelectedWorkflowId("");
      return;
    }
    const preferredWorkflowId = selectedService?.workflowGraphId;
    if (preferredWorkflowId && serviceWorkflows.some((graph) => graph.id === preferredWorkflowId)) {
      setSelectedWorkflowId(preferredWorkflowId);
      return;
    }
    setSelectedWorkflowId((current) =>
      serviceWorkflows.some((graph) => graph.id === current) ? current : serviceWorkflows[0].id
    );
  }, [selectedServiceId, selectedService, serviceWorkflows]);

  const handleSave = useCallback(async () => {
    if (!selectedServiceId) {
      setStatusMessage({ type: "error", text: "Select a service before saving workflow" });
      return;
    }
    setSaving(true);
    setStatusMessage(null);
    setValidationErrors([]);
    try {
      const { payloadName, payloadNodes, payloadEdges } = getActivePayload(
        editorMode, 
        yamlContent, 
        nodes, 
        edges, 
        selectedWorkflowName || "Untitled Workflow"
      );

      const graph = await api.createWorkflow({
        name: payloadName,
        nodes: payloadNodes,
        edges: payloadEdges,
      });
      setWorkflows((prev) => [graph, ...prev.filter((existing) => existing.id !== graph.id)]);
      setSelectedWorkflowId(graph.id);
      if (editorMode === "yaml" && payloadName !== selectedWorkflowName) {
        setSelectedWorkflowName(payloadName);
      }
      setStatusMessage({ type: "success", text: `Workflow v${graph.version} saved successfully` });
    } catch (err) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [nodes, edges, selectedWorkflowName, editorMode, yamlContent, selectedServiceId]);

  const handleLoad = useCallback(async () => {
    if (!selectedServiceId) {
      setStatusMessage({ type: "error", text: "Select a service before loading workflow" });
      return;
    }
    setLoadingApi(true);
    setStatusMessage(null);
    setValidationErrors([]);
    try {
      let available = serviceWorkflows;
      if (available.length === 0) {
        const res = await api.listWorkflows();
        setWorkflows(res.graphs);
        available = res.graphs.filter((graph) => graph.serviceId === selectedServiceId).sort((a, b) => b.version - a.version);
      }
      if (available.length === 0) {
        setStatusMessage({ type: "info", text: "No saved workflows found for this service" });
        return;
      }
      const graph =
        available.find((candidate) => candidate.id === selectedWorkflowId) ??
        available[0];

      setNodes(
        graph.nodes.map((n, i) => {
          const nodeType: WorkflowNodeType = n.type;
          const nodeKind = isWorkflowNodeKind(n.kind) ? n.kind : "runShell";
          const data = (n.data ?? {}) as Record<string, unknown>;
          const displayName = typeof data.displayName === "string" ? data.displayName : "";
          const mergedData: WorkflowEditorNodeData = {
            ...data,
            nodeType,
            nodeKind,
            displayName,
            label: displayName.trim() || nodeKind
          };
          return {
            id: n.id,
            type: resolveVisualType(nodeType),
            position: n.position ?? { x: i * 220, y: 120 },
            data: mergedData
          };
        })
      );
      setEdges(
        graph.edges.map((e, i) => ({
          id: `e${i}`,
          source: e.from,
          target: e.to,
        }))
      );
      setSelectedWorkflowId(graph.id);
      setEditorMode("visual");
      setStatusMessage({ type: "success", text: `Loaded workflow v${graph.version} (${graph.nodes.length} nodes)` });
    } catch (err) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    } finally {
      setLoadingApi(false);
    }
  }, [selectedServiceId, selectedWorkflowId, serviceWorkflows]);

  const handleValidate = useCallback(() => {
    setStatusMessage(null);
    try {
      const { payloadName, payloadNodes, payloadEdges } = getActivePayload(
        editorMode, 
        yamlContent, 
        nodes, 
        edges, 
        selectedWorkflowName || "Untitled Workflow"
      );
      const errors = validateWorkflowGraph(toDomainNodes(payloadNodes), payloadEdges);
      
      if (errors.length === 0) {
        setValidationErrors([]);
        if (editorMode === "yaml" && payloadName !== selectedWorkflowName) {
          setSelectedWorkflowName(payloadName);
        }
        setStatusMessage({ type: "success", text: "Workflow graph is valid" });
      } else {
        setValidationErrors(errors.map((e) => e.message));
      }
    } catch (err) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    }
  }, [nodes, edges, selectedWorkflowName, editorMode, yamlContent]);

  const handleTestRun = useCallback(() => {
    if (!selectedServiceId) {
      setStatusMessage({ type: "error", text: "Select a service before test run" });
      return;
    }
    setStatusMessage(null);
    setTestRunResult(null);
    setValidationErrors([]);

    try {
      const { payloadName, payloadNodes, payloadEdges } = getActivePayload(
        editorMode, 
        yamlContent, 
        nodes, 
        edges, 
        selectedWorkflowName || "Untitled Workflow"
      );
      const errors = validateWorkflowGraph(toDomainNodes(payloadNodes), payloadEdges);
      
      if (errors.length > 0) {
        setValidationErrors(errors.map((e) => e.message));
        return;
      }
      
      void api.dryRunWorkflow({
        serviceId: selectedServiceId,
        name: payloadName,
        nodes: payloadNodes,
        edges: payloadEdges
      })
        .then((result) => {
          setTestRunResult(result.steps);
          if (editorMode === "yaml" && payloadName !== selectedWorkflowName) {
            setSelectedWorkflowName(payloadName);
          }
          setStatusMessage({
            type: result.success ? "success" : "error",
            text: result.success ? "Dry run completed successfully" : "Dry run finished with failures"
          });
        })
        .catch((err) => {
          setStatusMessage({ type: "error", text: (err as Error).message });
        });
    } catch (err) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    }
  }, [nodes, edges, selectedServiceId, selectedWorkflowName, editorMode, yamlContent]);

  const handleExecuteOnAgent = useCallback(async () => {
    if (!selectedServiceId) {
      setStatusMessage({ type: "error", text: "Select a service before executing workflow" });
      return;
    }
    setSaving(true);
    setStatusMessage(null);
    setValidationErrors([]);
    try {
      const { payloadName, payloadNodes, payloadEdges } = getActivePayload(
        editorMode, 
        yamlContent, 
        nodes, 
        edges, 
        selectedWorkflowName || "Untitled Workflow"
      );

      const execution = await api.executeWorkflow({
        serviceId: selectedServiceId,
        name: payloadName,
        nodes: payloadNodes,
        edges: payloadEdges,
      });
      if (editorMode === "yaml" && payloadName !== selectedWorkflowName) {
        setSelectedWorkflowName(payloadName);
      }
      setStatusMessage({
        type: "success",
        text: `Workflow v${execution.workflowVersion} saved; dispatch state is ${execution.dispatchState} for agent ${execution.agentId} (command ${execution.commandId})`
      });
    } catch (err) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [nodes, edges, selectedServiceId, selectedWorkflowName, editorMode, yamlContent]);

  const handleSetActiveWorkflow = useCallback(async () => {
    if (!selectedServiceId) {
      setStatusMessage({ type: "error", text: "Select a service before setting active workflow" });
      return;
    }
    if (!selectedWorkflowId) {
      setStatusMessage({ type: "error", text: "Select a saved workflow before setting active" });
      return;
    }
    try {
      const svc = await api.setServiceWorkflow(selectedServiceId, selectedWorkflowId);
      setServices((prev) => prev.map((existing) => (existing.id === svc.id ? svc : existing)));
      setStatusMessage({ type: "success", text: `Service now uses workflow ${selectedWorkflowId}` });
    } catch (err) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    }
  }, [selectedServiceId, selectedWorkflowId]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const nodeType = e.dataTransfer.getData("application/reactflow");
      if (!nodeType || !isWorkflowNodeKind(nodeType)) return;

      const position = reactFlow
        ? reactFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
        : { x: e.clientX, y: e.clientY };

      const newId = `node_${Date.now()}`;
      const nodeCategory = resolveNodeTypeFromKind(nodeType);
      const newNode: WorkflowEditorNode = {
        id: newId,
        type: resolveVisualType(nodeCategory),
        position,
        data: {
          nodeType: nodeCategory,
          nodeKind: nodeType,
          label: nodeType
        },
      };

      setNodes((prev) => [...prev, newNode]);
    },
    [reactFlow]
  );

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: WorkflowEditorNode) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
  }, []);

  const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, []);

  const updateNodeData = useCallback((nodeId: string, key: string, value: string) => {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId
          ? (() => {
            let nextData = { ...n.data, [key]: value } as WorkflowEditorNodeData;
            if (key === "nodeKind") {
              const nextKind = value as WorkflowNodeKind;
              const nextType = resolveNodeTypeFromKind(nextKind);
              nextData = sanitizeDataForNode(nextType, nextKind, { ...nextData, nodeType: nextType, nodeKind: nextKind });
            }
            nextData.label = getNodeLabel(nextData);
            return { ...n, type: resolveVisualType(nextData.nodeType), data: nextData };
          })()
          : n
      )
    );
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange<WorkflowEditorNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    if (selectedNodeId && changes.some((change) => change.type === "remove" && change.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId]);

  const handleNodesDelete = useCallback((deleted: Node[]) => {
    const deletedIds = new Set(deleted.map((node) => node.id));
    setSelectedNodeId((current) => (current && deletedIds.has(current) ? null : current));
    setSelectedEdgeId((current) => {
      if (!current) return current;
      const deletedSelectedEdge = edges.find((edge) => edge.id === current);
      if (!deletedSelectedEdge) return null;
      return deletedIds.has(deletedSelectedEdge.source) || deletedIds.has(deletedSelectedEdge.target) ? null : current;
    });
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
    if (selectedEdgeId && changes.some((change) => change.type === "remove" && change.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [selectedEdgeId]);

  const handleEdgesDelete = useCallback((deleted: Edge[]) => {
    const deletedIds = new Set(deleted.map((edge) => edge.id));
    setSelectedEdgeId((current) => (current && deletedIds.has(current) ? null : current));
  }, []);

  const handleConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) {
      return;
    }
    if (connection.source === connection.target) {
      return;
    }
    const sourceNode = nodes.find((node) => node.id === connection.source);
    const targetNode = nodes.find((node) => node.id === connection.target);
    if (!sourceNode || !targetNode) {
      return;
    }
    if (targetNode.data.nodeType === "event") {
      setStatusMessage({ type: "error", text: "Edges cannot target event nodes" });
      return;
    }
    setEdges((current) => {
      const exists = current.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          (edge.sourceHandle ?? null) === (connection.sourceHandle ?? null) &&
          (edge.targetHandle ?? null) === (connection.targetHandle ?? null)
      );
      if (exists) {
        return current;
      }
      return addEdge({ ...connection, id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }, current);
    });
  }, [nodes]);

  const handleDeleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, [selectedNodeId]);

  const handleDisconnectSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedEdgeId(null);
  }, [selectedNodeId]);

  const handleDeleteSelectedEdge = useCallback(() => {
    if (!selectedEdgeId) return;
    setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
    setSelectedEdgeId(null);
  }, [selectedEdgeId]);

  const statusColorMap = { success: "var(--color-success)", error: "var(--color-danger)", info: "var(--color-info)" };
  const statusBgMap = { success: "var(--color-success-bg)", error: "var(--color-danger-bg)", info: "var(--color-info-bg)" };

  return (
    <section>
      <h2 style={{ margin: "0 0 1rem" }}>Workflow Editor</h2>
      <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12 }}>
        <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)", marginRight: "auto" }}>
            Sample graph: trigger → branchIf → parallel plans → join → slack
          </span>
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
                <option key={svc.id} value={svc.id}>
                  {svc.name}
                </option>
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
              <option value="">{serviceWorkflows.length === 0 ? "No workflows for service" : "Select workflow"}</option>
              {serviceWorkflows.map((graph) => (
                <option key={graph.id} value={graph.id}>
                  {graph.name} (v{graph.version}) - {graph.id.slice(0, 8)}{selectedService?.workflowGraphId === graph.id ? " (active)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
            Name
            <input
              value={selectedWorkflowName}
              onChange={(e) => setSelectedWorkflowName(e.target.value)}
              placeholder="e.g. restart-app"
              style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.2rem 0.35rem", background: "var(--color-surface)", color: "var(--color-text-primary)", width: 120 }}
            />
          </label>
          <Button size="sm" variant="secondary" onClick={handleValidate}>
            Validate
          </Button>
          <Button size="sm" variant="secondary" onClick={handleLoad} loading={loadingApi}>
            Load selected
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void refreshWorkflows()} loading={loadingWorkflows}>
            Refresh list
          </Button>
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
          }} style={{ background: "purple", color: "white" }}>
            Auto-fill Test Workflow
          </Button>
          <Button size="sm" variant="secondary" onClick={handleToggleMode}>
            {editorMode === "visual" ? "Switch to YAML" : "Switch to Visual"}
          </Button>
          <Button size="sm" onClick={handleSave} loading={saving}>
            Save Workflow
          </Button>
          <Button size="sm" variant="secondary" onClick={handleSetActiveWorkflow}>
            Set active
          </Button>
          <Button size="sm" variant="secondary" onClick={handleTestRun} style={{ background: "var(--color-info)", color: "var(--color-primary-foreground)", borderColor: "var(--color-info)" }}>
            Validate / Dry run
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

        {editorMode === "visual" ? (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 220px" }}>
            <div style={{ height: 360 }} onDragOver={handleDragOver} onDrop={handleDrop}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={WORKFLOW_NODE_RENDERERS}
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

            <aside
              aria-label="Side panel"
              style={{ borderLeft: "1px solid var(--color-border)", padding: "0.75rem", fontSize: "0.8rem", overflow: "auto", maxHeight: 360 }}
            >
              {selectedNode ? (
                <NodeConfigPanel
                  node={selectedNode}
                  onUpdate={updateNodeData}
                  onDeleteNode={handleDeleteSelectedNode}
                  onDisconnectNode={handleDisconnectSelectedNode}
                  onClose={() => setSelectedNodeId(null)}
                />
              ) : selectedEdge ? (
                <EdgeConfigPanel edge={selectedEdge} onDeleteEdge={handleDeleteSelectedEdge} onClose={() => setSelectedEdgeId(null)} />
              ) : (
                <PalettePanel filter={paletteFilter} onFilterChange={setPaletteFilter} />
              )}
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
      </div>
    </section>
  );
}

type WorkflowCategoryNodeProps = NodeProps<WorkflowEditorNode>;

function WorkflowEventNode({ data }: WorkflowCategoryNodeProps) {
  return (
    <div
      role="button"
      aria-label={`Event node ${getNodeLabel(data)}`}
      style={{
        minWidth: 132,
        minHeight: 46,
        padding: "0.5rem 0.75rem",
        border: "1px solid var(--color-info)",
        borderRadius: 999,
        background: "var(--color-info-bg)",
        color: "var(--color-info)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        fontSize: "0.75rem",
        fontWeight: 600
      }}
    >
      <Handle type="target" position={Position.Top} />
      <span>{getNodeLabel(data)}</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function WorkflowActionNode({ data }: WorkflowCategoryNodeProps) {
  return (
    <div
      role="button"
      aria-label={`Action node ${getNodeLabel(data)}`}
      style={{
        minWidth: 144,
        minHeight: 56,
        padding: "0.65rem 0.8rem",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        background: "var(--color-surface)",
        color: "var(--color-text-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        fontSize: "0.75rem",
        fontWeight: 600
      }}
    >
      <Handle type="target" position={Position.Top} />
      <span>{getNodeLabel(data)}</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function WorkflowControlNode({ data }: WorkflowCategoryNodeProps) {
  return (
    <div
      style={{
        width: 140,
        height: 86,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative"
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div
        style={{
          width: 90,
          height: 90,
          border: "1px solid var(--color-warning)",
          background: "var(--color-warning-bg)",
          color: "var(--color-warning)",
          clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "0.65rem",
          boxSizing: "border-box",
          fontSize: "0.72rem",
          fontWeight: 700,
          lineHeight: 1.1
        }}
      >
        {getNodeLabel(data)}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const WORKFLOW_NODE_RENDERERS: NodeTypes = {
  eventNode: WorkflowEventNode,
  actionNode: WorkflowActionNode,
  controlNode: WorkflowControlNode
};

function NodeConfigPanel({
  node,
  onUpdate,
  onDeleteNode,
  onDisconnectNode,
  onClose,
}: {
  node: WorkflowEditorNode;
  onUpdate: (nodeId: string, key: string, value: string) => void;
  onDeleteNode: () => void;
  onDisconnectNode: () => void;
  onClose: () => void;
}) {
  const nodeKind = node.data.nodeKind;
  const showFilterField = nodeKind === "onLogPattern";
  const showScheduleField = nodeKind === "onSchedule";

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
      <div style={{ display: "flex", gap: "0.35rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
        <Button size="sm" variant="secondary" onClick={onDisconnectNode}>
          Disconnect node
        </Button>
        <Button size="sm" variant="danger" onClick={onDeleteNode}>
          Delete node
        </Button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span style={{ color: "var(--color-text-secondary)" }}>Node kind</span>
          <select
            value={String(node.data.nodeKind)}
            onChange={(e) => onUpdate(node.id, "nodeKind", e.target.value)}
            style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.3rem", background: "var(--color-surface)", color: "var(--color-text-primary)" }}
          >
            {WORKFLOW_NODE_TYPES.map((nodeType) => (
              <option key={nodeType} value={nodeType}>
                {nodeType}
              </option>
            ))}
          </select>
        </label>
        <div style={{ color: "var(--color-text-secondary)", fontSize: "0.75rem" }}>
          Category: <strong>{node.data.nodeType}</strong>
        </div>
        <Input
          label="Display name"
          value={String(node.data.displayName ?? "")}
          onChange={(e) => onUpdate(node.id, "displayName", e.target.value)}
          placeholder={String(node.data.nodeKind)}
        />
        {showFilterField && (
          <Input
            label="Filter"
            placeholder="e.g. severity=critical"
            value={String(node.data.filter ?? "")}
            onChange={(e) => onUpdate(node.id, "filter", e.target.value)}
          />
        )}
        {showScheduleField && (
          <Input
            label="Schedule (cron)"
            placeholder="*/5 * * * *"
            value={String(node.data.schedule ?? "")}
            onChange={(e) => onUpdate(node.id, "schedule", e.target.value)}
          />
        )}
        {["runShell", "runGradlew", "runPip", "runNpm", "runMaven", "runGo"].includes(String(node.data.nodeKind)) && (
          <Input
            label={node.data.nodeKind === "runShell" ? "Command" : "Arguments"}
            placeholder={node.data.nodeKind === "runShell" ? "npm test" : "e.g. install, build, test"}
            value={String(node.data.command ?? "")}
            onChange={(e) => onUpdate(node.id, "command", e.target.value)}
          />
        )}
        {node.data.nodeKind === "httpRequest" && (
          <>
            <Input
              label="HTTP method"
              placeholder="GET"
              value={String(node.data.method ?? "")}
              onChange={(e) => onUpdate(node.id, "method", e.target.value)}
            />
            <Input
              label="URL"
              placeholder="https://example.com/hook"
              value={String(node.data.url ?? "")}
              onChange={(e) => onUpdate(node.id, "url", e.target.value)}
            />
          </>
        )}
        {node.data.nodeKind === "slackNotify" && (
          <>
            <Input
              label="Channel"
              placeholder="#alerts"
              value={String(node.data.channel ?? "")}
              onChange={(e) => onUpdate(node.id, "channel", e.target.value)}
            />
            <Input
              label="Webhook ref"
              placeholder="secret://slack/webhook"
              value={String(node.data.webhookRef ?? "")}
              onChange={(e) => onUpdate(node.id, "webhookRef", e.target.value)}
            />
          </>
        )}
        {(node.data.nodeKind === "branchIf" || node.data.nodeKind === "if" || node.data.nodeKind === "loop") && (
          <Input
            label="Condition"
            placeholder="severity=critical"
            value={String(node.data.condition ?? "")}
            onChange={(e) => onUpdate(node.id, "condition", e.target.value)}
          />
        )}
        {node.data.nodeKind === "template" && (
          <Input
            label="Template"
            placeholder="{{ incident.message }}"
            value={String(node.data.template ?? "")}
            onChange={(e) => onUpdate(node.id, "template", e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

function EdgeConfigPanel({
  edge,
  onDeleteEdge,
  onClose,
}: {
  edge: Edge;
  onDeleteEdge: () => void;
  onClose: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <div style={{ fontWeight: 600 }}>Edge Config</div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          ✕
        </Button>
      </div>
      <div style={{ marginBottom: "0.75rem", color: "var(--color-text-secondary)", fontSize: "0.75rem" }}>
        {edge.source} → {edge.target}
      </div>
      <Button size="sm" variant="danger" onClick={onDeleteEdge}>
        Delete edge
      </Button>
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
      <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Node palette</div>
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
