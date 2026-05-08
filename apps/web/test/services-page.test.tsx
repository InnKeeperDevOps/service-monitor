import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listServices, listSshKeys, createService, updateService, deleteService } = vi.hoisted(() => ({
  listServices: vi.fn(),
  listSshKeys: vi.fn(),
  createService: vi.fn(),
  updateService: vi.fn(),
  deleteService: vi.fn()
}));

const adminAuthState = {
  user: {
    id: "u1",
    email: "admin@example.com",
    role: "admin" as const,
    tenantId: "t1",
    memberships: [{ tenantId: "t1", tenantName: "Acme", role: "admin" as const }]
  },
  role: "admin" as const,
  isAdmin: true,
  isOperator: false,
  isViewer: false
};

let mockUseAuth = adminAuthState;

vi.mock("../src/lib/useAuth.js", () => ({
  useAuth: () => mockUseAuth
}));

vi.mock("../src/lib/api.js", () => ({
  api: {
    listServices,
    listSshKeys,
    createService,
    updateService,
    deleteService
  }
}));

import { ServicesPage } from "../src/features/services/ServicesPage.js";

describe("ServicesPage", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUseAuth = adminAuthState;
    listServices.mockReset();
    listSshKeys.mockReset();
    createService.mockReset();
    updateService.mockReset();
    deleteService.mockReset();

    listServices.mockResolvedValue({ services: [] });
    listSshKeys.mockResolvedValue({ keys: [] });
  });

  it("renders services and allows creating a new one with gitRepoUrl and sshKeyId", async () => {
    listSshKeys.mockResolvedValue({
      keys: [
        { id: "key-1", name: "Deploy Key 1", type: "uploaded", createdAt: "", updatedAt: "", tenantId: "t1" }
      ]
    });
    
    render(<ServicesPage />);
    
    await waitFor(() => {
      expect(screen.queryByText("No services configured yet.")).toBeInTheDocument();
    });

    const addBtn = screen.getByRole("button", { name: "Add Service" });
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(screen.getByLabelText(/Git Repository URL/)).toBeInTheDocument();
      expect(screen.getByLabelText(/SSH Key/)).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText(/Name/);
    const repoInput = screen.getByLabelText(/Git Repository URL/);
    const sshKeySelect = screen.getByLabelText(/SSH Key/);
    const branchInput = screen.getByLabelText(/Branch/);

    fireEvent.change(nameInput, { target: { value: "test-svc" } });
    fireEvent.change(repoInput, { target: { value: "git@github.com:acme/test-svc.git" } });
    fireEvent.change(sshKeySelect, { target: { value: "key-1" } });
    fireEvent.change(branchInput, { target: { value: "develop" } });

    createService.mockResolvedValue({
      id: "svc-1",
      tenantId: "t1",
      name: "test-svc",
      gitRepoUrl: "git@github.com:acme/test-svc.git",
      sshKeyId: "key-1",
      branch: "develop",
      agentId: null,
      dockerImage: null,
      composePath: null,
      agentRuntimeBackend: "shell"
    });

    const submitBtn = screen.getByRole("button", { name: "Create" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createService).toHaveBeenCalledWith({
        name: "test-svc",
        gitRepoUrl: "git@github.com:acme/test-svc.git",
        sshKeyId: "key-1",
        branch: "develop",
        dockerImage: undefined,
        composePath: undefined,
        agentRuntimeBackend: undefined
      });
      expect(screen.getByText("test-svc")).toBeInTheDocument();
      expect(screen.getByText("git@github.com:acme/test-svc.git")).toBeInTheDocument();
    });
  });

  it("allows editing an existing service", async () => {
    listServices.mockResolvedValue({
      services: [
        {
          id: "svc-1",
          tenantId: "t1",
          name: "test-svc",
          gitRepoUrl: "git@github.com:acme/test-svc.git",
          sshKeyId: "key-1",
          branch: "develop",
          agentId: null,
          dockerImage: null,
          composePath: null,
          agentRuntimeBackend: "shell"
        }
      ]
    });

    render(<ServicesPage />);
    
    await waitFor(() => {
      expect(screen.getByText("test-svc")).toBeInTheDocument();
    });

    const editBtn = screen.getByRole("button", { name: "Edit" });
    fireEvent.click(editBtn);

    await waitFor(() => {
      expect(screen.getByLabelText(/Name/)).toHaveValue("test-svc");
    });

    const branchInput = screen.getByLabelText(/Branch/);
    fireEvent.change(branchInput, { target: { value: "main" } });

    updateService.mockResolvedValue({
      id: "svc-1",
      tenantId: "t1",
      name: "test-svc",
      gitRepoUrl: "git@github.com:acme/test-svc.git",
      sshKeyId: "key-1",
      branch: "main",
      agentId: null,
      dockerImage: null,
      composePath: null,
      agentRuntimeBackend: "shell"
    });

    const submitBtn = screen.getByRole("button", { name: "Save Changes" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(updateService).toHaveBeenCalledWith("svc-1", {
        name: "test-svc",
        gitRepoUrl: "git@github.com:acme/test-svc.git",
        sshKeyId: "key-1",
        branch: "main",
        dockerImage: undefined,
        composePath: undefined,
        agentRuntimeBackend: "shell"
      });
    });
  });

  it("allows deleting a service after confirmation", async () => {
    listServices.mockResolvedValue({
      services: [
        {
          id: "svc-1",
          tenantId: "t1",
          name: "test-svc",
          gitRepoUrl: "git@github.com:acme/test-svc.git",
          sshKeyId: "key-1",
          branch: "develop",
          agentId: null,
          dockerImage: null,
          composePath: null,
          agentRuntimeBackend: "shell"
        }
      ]
    });
    deleteService.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ServicesPage />);

    await waitFor(() => {
      expect(screen.getByText("test-svc")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteService).toHaveBeenCalledWith("svc-1");
      expect(screen.queryByText("test-svc")).not.toBeInTheDocument();
    });

    confirmSpy.mockRestore();
  });

  it("does not delete when confirmation is cancelled", async () => {
    listServices.mockResolvedValue({
      services: [
        {
          id: "svc-1",
          tenantId: "t1",
          name: "test-svc",
          gitRepoUrl: "git@github.com:acme/test-svc.git",
          sshKeyId: "key-1",
          branch: "develop",
          agentId: null,
          dockerImage: null,
          composePath: null,
          agentRuntimeBackend: "shell"
        }
      ]
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<ServicesPage />);

    await waitFor(() => {
      expect(screen.getByText("test-svc")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleteService).not.toHaveBeenCalled();
    expect(screen.getByText("test-svc")).toBeInTheDocument();

    confirmSpy.mockRestore();
  });
});