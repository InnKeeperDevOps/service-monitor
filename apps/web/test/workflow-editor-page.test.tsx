import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { WorkflowEditorPage } from "../src/features/workflow-editor/WorkflowEditorPage.js";
import { api } from "../src/lib/api.js";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual as any,
    ReactFlow: ({ children, nodes, edges }: any) => {
      return (
        <div data-testid="react-flow-mock" data-node-count={nodes?.length} data-edge-count={edges?.length}>
          {children}
        </div>
      );
    },
    Background: () => <div data-testid="rf-bg" />,
    Controls: () => <div data-testid="rf-controls" />,
    MiniMap: () => <div data-testid="rf-minimap" />,
    Handle: () => <div data-testid="rf-handle" />,
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  };
});

vi.mock("../src/lib/api.js", () => ({
  api: {
    listServices: vi.fn(),
    listWorkflows: vi.fn(),
    createWorkflow: vi.fn(),
    setServiceWorkflow: vi.fn(),
    executeWorkflow: vi.fn(),
    dryRunWorkflow: vi.fn()
  }
}));

describe("WorkflowEditorPage", () => {
  const mockServices = [
    { id: "svc-1", name: "Service 1", workflowGraphId: "wf-1" },
    { id: "svc-2", name: "Service 2", workflowGraphId: null },
  ];

  const mockWorkflows = [
    {
      id: "wf-1",
      name: "Test Workflow",
      version: 1,
      nodes: [{ id: "n1", type: "event", kind: "onCrash", position: { x: 0, y: 0 } }],
      edges: [],
      isActive: true
    },
    {
      id: "wf-2",
      name: "Unused Workflow",
      version: 1,
      nodes: [],
      edges: [],
      isActive: false
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads services and workflows on mount", async () => {
    vi.mocked(api.listServices).mockResolvedValueOnce({ services: mockServices as any });
    vi.mocked(api.listWorkflows).mockResolvedValueOnce({ graphs: mockWorkflows as any });

    render(<WorkflowEditorPage />);

    await waitFor(() => {
      expect(api.listServices).toHaveBeenCalled();
      expect(api.listWorkflows).toHaveBeenCalled();
    });

    expect(screen.getByRole("combobox", { name: /Service/i })).toBeInTheDocument();
    
    await waitFor(() => {
      const select = screen.getByRole("combobox", { name: /Service/i }) as HTMLSelectElement;
      expect(select.value).toBe("svc-1");
    });
  });

  it("keeps selected workflow when service changes", async () => {
    vi.mocked(api.listServices).mockResolvedValueOnce({ services: mockServices as any });
    vi.mocked(api.listWorkflows).mockResolvedValueOnce({ graphs: mockWorkflows as any });

    render(<WorkflowEditorPage />);

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /Service/i })).toBeInTheDocument();
    });

    const svcSelect = screen.getByRole("combobox", { name: /Service/i });
    fireEvent.change(svcSelect, { target: { value: "svc-2" } });

    await waitFor(() => {
      const wfSelect = screen.getByRole("combobox", { name: /Saved/i }) as HTMLSelectElement;
      expect(wfSelect.value).toBe("wf-1");
    });
  });

  it("can load a workflow into the editor", async () => {
    vi.mocked(api.listServices).mockResolvedValueOnce({ services: mockServices as any });
    vi.mocked(api.listWorkflows).mockResolvedValueOnce({ graphs: mockWorkflows as any });

    render(<WorkflowEditorPage />);

    await waitFor(() => {
      const wfSelect = screen.getByRole("combobox", { name: /Saved/i }) as HTMLSelectElement;
      expect(wfSelect.value).toBe("wf-1");
    });

    fireEvent.change(screen.getByRole("combobox", { name: /Saved/i }), { target: { value: "wf-1" } });

    await waitFor(() => {
      expect(screen.getByText(/Loaded workflow v1/)).toBeInTheDocument();
    });
  });

  it("can save a workflow", async () => {
    vi.mocked(api.listServices).mockResolvedValueOnce({ services: mockServices as any });
    vi.mocked(api.listWorkflows).mockResolvedValueOnce({ graphs: mockWorkflows as any });
    vi.mocked(api.createWorkflow).mockResolvedValueOnce({
      ...mockWorkflows[0],
      version: 2
    } as any);

    render(<WorkflowEditorPage />);

    await waitFor(() => {
      const select = screen.getByRole("combobox", { name: /Service/i }) as HTMLSelectElement;
      expect(select.value).toBe("svc-1");
    });

    await waitFor(() => {
      expect(screen.getByText(/Loaded workflow v1/)).toBeInTheDocument();
    });

    const nameInput = screen.getByPlaceholderText("e.g. restart-app");
    fireEvent.change(nameInput, { target: { value: "My New Workflow" } });

    fireEvent.click(screen.getByRole("button", { name: "Save Workflow" }));

    await waitFor(() => {
      expect(api.createWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "My New Workflow"
        })
      );
      expect(screen.getByText("Workflow v2 saved successfully")).toBeInTheDocument();
    });
  });

  it("can execute on agent", async () => {
    vi.mocked(api.listServices).mockResolvedValueOnce({ services: mockServices as any });
    vi.mocked(api.listWorkflows).mockResolvedValueOnce({ graphs: mockWorkflows as any });
    vi.mocked(api.executeWorkflow).mockResolvedValueOnce({
      accepted: true,
      workflowId: "wf-1",
      workflowVersion: 1,
      agentId: "ag-1",
      commandId: "cmd-1",
      dispatchState: "queued_for_dispatch"
    });

    render(<WorkflowEditorPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Queue on Agent" })).toBeInTheDocument();
      expect(screen.getByText(/Loaded workflow v1/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Queue on Agent" }));

    await waitFor(() => {
      expect(api.executeWorkflow).toHaveBeenCalled();
      expect(screen.getByText(/queued_for_dispatch for agent ag-1/)).toBeInTheDocument();
    });
  });

  it("can run dry run", async () => {
    vi.mocked(api.listServices).mockResolvedValueOnce({ services: mockServices as any });
    vi.mocked(api.listWorkflows).mockResolvedValueOnce({ graphs: mockWorkflows as any });
    vi.mocked(api.dryRunWorkflow).mockResolvedValueOnce({
      success: true,
      steps: [{ nodeId: "n1", nodeType: "event", success: true, output: "ok" }]
    });

    render(<WorkflowEditorPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Dry run" })).toBeInTheDocument();
      expect(screen.getByText(/Loaded workflow v1/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));

    await waitFor(() => {
      expect(api.dryRunWorkflow).toHaveBeenCalled();
      expect(screen.getByText("Dry run completed successfully")).toBeInTheDocument();
      expect(screen.getByText("PASS event (n1) - ok")).toBeInTheDocument();
    });
  });

  it("can set active workflow", async () => {
    vi.mocked(api.listServices).mockResolvedValueOnce({ services: mockServices as any });
    vi.mocked(api.listWorkflows).mockResolvedValueOnce({ graphs: mockWorkflows as any });
    vi.mocked(api.setServiceWorkflow).mockResolvedValueOnce({ ...mockServices[0], workflowGraphId: "wf-1" } as any);

    render(<WorkflowEditorPage />);

    await waitFor(() => {
      const select = screen.getByRole("combobox", { name: /Saved/i }) as HTMLSelectElement;
      expect(select.value).toBe("wf-1");
    });
    
    // Specifically trigger change to ensure it is selected
    fireEvent.change(screen.getByRole("combobox", { name: /Saved/i }), { target: { value: "wf-1" } });

    fireEvent.click(screen.getByRole("button", { name: "Set active" }));

    await waitFor(() => {
      expect(api.setServiceWorkflow).toHaveBeenCalledWith("svc-1", "wf-1");
      expect(screen.getByText("Service now uses workflow wf-1")).toBeInTheDocument();
    });
  });
});
