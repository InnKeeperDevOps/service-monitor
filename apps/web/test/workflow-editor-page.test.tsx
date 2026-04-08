import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { listServices, listWorkflows } = vi.hoisted(() => ({
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
  listWorkflows: vi.fn(async () => ({ graphs: [] }))
}));

vi.mock("@xyflow/react", () => ({
  addEdge: (connection: unknown, edges: unknown[]) => [...edges, connection],
  applyEdgeChanges: (_changes: unknown[], edges: unknown[]) => edges,
  applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
  Background: () => <div data-testid="rf-bg" />,
  Controls: () => <div data-testid="rf-controls" />,
  MiniMap: () => <div data-testid="rf-minimap" />,
  ReactFlow: ({ children }: { children: ReactNode }) => <div data-testid="rf-root">{children}</div>
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
  });

  it("filters palette items by search text", async () => {
    render(<WorkflowEditorPage />);

    const searchInput = await screen.findByPlaceholderText("Search nodes...");
    fireEvent.change(searchInput, { target: { value: "onCrash" } });

    expect(screen.getByText("onCrash")).toBeInTheDocument();
    expect(screen.queryByText("dockerBuild")).not.toBeInTheDocument();
  });
});
