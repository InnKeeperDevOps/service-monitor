import { describe, it, expect } from "vitest";
import {
  isWorkflowNodeKind,
  resolveNodeTypeFromKind,
  resolveVisualType,
  sanitizeDataForNode,
  getNodeLabel,
  toWorkflowNodes,
  toWorkflowEdges,
  toDomainNodes,
  visualToYaml,
  yamlToVisual,
  getActivePayload,
  type WorkflowEditorNode
} from "../src/features/workflow-editor/workflow-sync.js";
import type { Edge } from "@xyflow/react";

describe("workflow-sync", () => {
  describe("isWorkflowNodeKind", () => {
    it("should return true for known node kinds", () => {
      expect(isWorkflowNodeKind("onCrash")).toBe(true);
      expect(isWorkflowNodeKind("runShell")).toBe(true);
      expect(isWorkflowNodeKind("branchIf")).toBe(true);
    });

    it("should return false for unknown node kinds", () => {
      expect(isWorkflowNodeKind("unknown")).toBe(false);
    });
  });

  describe("resolveNodeTypeFromKind", () => {
    it("should resolve correctly", () => {
      expect(resolveNodeTypeFromKind("onCrash")).toBe("event");
      expect(resolveNodeTypeFromKind("branchIf")).toBe("control");
      expect(resolveNodeTypeFromKind("runShell")).toBe("action");
    });
  });

  describe("resolveVisualType", () => {
    it("should map nodeType to visual type", () => {
      expect(resolveVisualType("event")).toBe("eventNode");
      expect(resolveVisualType("control")).toBe("controlNode");
      expect(resolveVisualType("action")).toBe("actionNode");
    });
  });

  describe("sanitizeDataForNode", () => {
    it("should sanitize event node data based on allowed keys", () => {
      const data = {
        nodeType: "event" as const,
        nodeKind: "onLogPattern" as const,
        label: "onLogPattern",
        filter: "error",
        invalidKey: "should-be-removed"
      };
      const result = sanitizeDataForNode("event", "onLogPattern", data);
      expect(result).toHaveProperty("filter", "error");
      expect(result).not.toHaveProperty("invalidKey");
    });
  });

  describe("getNodeLabel", () => {
    it("should prioritize displayName over nodeKind", () => {
      expect(getNodeLabel({ nodeType: "action", nodeKind: "runShell", label: "runShell", displayName: "Custom Name" })).toBe("Custom Name");
      expect(getNodeLabel({ nodeType: "action", nodeKind: "runShell", label: "runShell" })).toBe("runShell");
      expect(getNodeLabel({ nodeType: "action", nodeKind: "runShell", label: "runShell", displayName: "   " })).toBe("runShell");
    });
  });

  describe("transformation mappings", () => {
    const nodes: WorkflowEditorNode[] = [
      { id: "n1", type: "actionNode", position: { x: 0, y: 0 }, data: { nodeType: "action", nodeKind: "runShell", label: "runShell", command: "echo test" } }
    ];
    const edges: Edge[] = [
      { id: "e1", source: "n1", target: "n2" }
    ];

    it("toWorkflowNodes should map correctly", () => {
      const result = toWorkflowNodes(nodes);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("n1");
      expect(result[0].data?.command).toBe("echo test");
    });

    it("toWorkflowEdges should map correctly", () => {
      const result = toWorkflowEdges(edges);
      expect(result).toHaveLength(1);
      expect(result[0].from).toBe("n1");
      expect(result[0].to).toBe("n2");
    });

    it("toDomainNodes should map payload nodes", () => {
      const payloadNodes = toWorkflowNodes(nodes);
      const domainNodes = toDomainNodes(payloadNodes);
      expect(domainNodes).toHaveLength(1);
      expect(domainNodes[0].type).toBe("action");
      expect(domainNodes[0].position).toEqual({ x: 0, y: 0 });
    });

    it("visualToYaml and yamlToVisual should convert back and forth", () => {
      const yamlContent = visualToYaml("Test Workflow", nodes, edges);
      expect(yamlContent).toContain("name: Test Workflow");
      expect(yamlContent).toContain("runShell");

      const visual = yamlToVisual(yamlContent);
      expect(visual.name).toBe("Test Workflow");
      expect(visual.nodes).toHaveLength(1);
      expect(visual.edges).toHaveLength(1);
      expect(visual.nodes[0].data.command).toBe("echo test");
      expect(visual.edges[0].source).toBe("n1");
    });
    
    it("yamlToVisual should throw on invalid yaml", () => {
      expect(() => yamlToVisual("invalid: yaml: [")).toThrow("YAML Parse Error");
    });

    it("yamlToVisual should throw on schema mismatch", () => {
      expect(() => yamlToVisual("nodes: []\nedges: {}")).toThrow("Invalid YAML structure");
    });
  });

  describe("getActivePayload", () => {
    const nodes: WorkflowEditorNode[] = [
      { id: "n1", type: "actionNode", position: { x: 0, y: 0 }, data: { nodeType: "action", nodeKind: "runShell", label: "runShell", command: "echo visual" } }
    ];
    const edges: Edge[] = [];
    
    const yamlContent = `
name: "Visual Name"
nodes:
  - id: "n1"
    type: "action"
    kind: "runShell"
    data:
      command: "echo yaml"
edges: []
`;

    it("should return visual nodes when editorMode is visual", () => {
      const payload = getActivePayload("visual", yamlContent, nodes, edges, "Visual Name");
      expect(payload.payloadName).toBe("Visual Name");
      expect(payload.payloadNodes[0].data?.command).toBe("echo visual");
    });

    it("should return parsed yaml nodes when editorMode is yaml", () => {
      const payload = getActivePayload("yaml", yamlContent, nodes, edges, "Visual Name");
      expect(payload.payloadName).toBe("Visual Name"); // YAML has no name, so it falls back to visual name
      expect(payload.payloadNodes[0].data?.command).toBe("echo yaml");
    });

    it("should return parsed yaml name when editorMode is yaml", () => {
      const yamlContentWithName = `
name: "YAML Name"
nodes: []
edges: []
`;
      const payload = getActivePayload("yaml", yamlContentWithName, nodes, edges, "Visual Name");
      expect(payload.payloadName).toBe("YAML Name");
    });

    it("should throw error for invalid yaml when editorMode is yaml", () => {
      expect(() => getActivePayload("yaml", "invalid", nodes, edges, "Visual Name")).toThrow("Invalid YAML structure");
    });
  });
});
