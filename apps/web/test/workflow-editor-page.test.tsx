import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { listServices, listWorkflows, lastReactFlowProps } = vi.hoisted(() => {
  const lastReactFlowProps: { current: Record<string, unknown> | null } = { current: null };
  return {
    listServices: vi.fn(async () => ({
      services: [
        {
          id: "svc-1",
          tenantId: "t-1",
          name: "api",
          repo: "o/r",
          branch: "main",
          agentId: null,
          workflowGraphId: null
        }
      ]
    })),
    listWorkflows: vi.fn(async () => ({ graphs: [] })),
    lastReactFlowProps
  };
});

vi.mock("@xyflow/react", () => ({
  addEdge: (connection: unknown, edges: unknown[]) => [...edges, connection],
  applyEdgeChanges: (_changes: unknown[], edges: unknown[]) => edges,
  applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
  Background: () => <div data-testid="rf-bg" />,
  Controls: () => <div data-testid="rf-controls" />,
  MiniMap: () => <div data-testid="rf-minimap" />,
  ReactFlow: ({
    children,
    nodes,
    ...rest
  }: {
    children: ReactNode;
    nodes?: Array<{ id: string; type?: string; data?: { label?: string } }>;
    [key: string]: unknown;
  }) => {
    lastReactFlowProps.current = rest;
    return (
      <div data-testid="rf-root">
        {children}
        <ul data-testid="rf-node-list">
          {(nodes ?? []).map((node) => (
            <li key={node.id} data-testid="rf-node" data-render-type={node.type ?? "default"}>
              {node.data?.label ?? node.id}
            </li>
          ))}
        </ul>
      </div>
    );
  }
}));

vi.mock("../src/lib/api.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/api.js")>();
  return {
    ...mod,
    api: {
      ...mod.api,
      listServices,
      listWorkflows
    }
  };
});

import { WorkflowEditorPage } from "../src/features/workflow-editor/WorkflowEditorPage.js";

describe("WorkflowEditorPage", () => {
  it("loads services/workflows and renders editor controls", async () => {
    render(<WorkflowEditorPage />);

    expect(screen.getByText("Workflow Editor")).toBeInTheDocument();
    expect(screen.getByTestId("rf-root")).toBeInTheDocument();

    await waitFor(() => {
      expect(listServices).toHaveBeenCalledTimes(1);
      expect(listWorkflows).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByRole("button", { name: "Save Workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate / Dry run" })).toBeInTheDocument();
    expect(screen.getByText("Node palette")).toBeInTheDocument();
    expect(screen.getByText("runShell")).toBeInTheDocument();

    const renderTypes = screen.getAllByTestId("rf-node").map((el) => el.getAttribute("data-render-type"));
    expect(renderTypes).toContain("eventNode");
    expect(renderTypes).toContain("actionNode");
    expect(renderTypes).toContain("controlNode");
  });

  it("configures ReactFlow for fit view and snap-to-grid", () => {
    render(<WorkflowEditorPage />);

    expect(lastReactFlowProps.current).not.toBeNull();
    expect(lastReactFlowProps.current?.fitView).toBe(true);
    expect(lastReactFlowProps.current?.fitViewOptions).toEqual({ maxZoom: 1.2 });
    expect(lastReactFlowProps.current?.snapToGrid).toBe(true);
    expect(lastReactFlowProps.current?.snapGrid).toEqual([20, 20]);
  });

  it("filters palette items by search text", async () => {
    render(<WorkflowEditorPage />);

    const searchInput = await screen.findByPlaceholderText("Search nodes...");
    fireEvent.change(searchInput, { target: { value: "onCrash" } });

    const sidePanel = screen.getByLabelText("Side panel");
    expect(within(sidePanel).getByText("onCrash")).toBeInTheDocument();
    expect(within(sidePanel).queryByText("dockerBuild")).not.toBeInTheDocument();
  });
});
