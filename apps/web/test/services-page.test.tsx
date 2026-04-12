import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listServices, listSshKeys, createService } = vi.hoisted(() => ({
  listServices: vi.fn(),
  listSshKeys: vi.fn(),
  createService: vi.fn()
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
    createService
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
      composePath: null
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
        composePath: undefined
      });
      expect(screen.getByText("test-svc")).toBeInTheDocument();
      expect(screen.getByText("git@github.com:acme/test-svc.git")).toBeInTheDocument();
    });
  });
});