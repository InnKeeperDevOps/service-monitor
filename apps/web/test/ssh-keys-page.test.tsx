import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listSshKeys, createSshKey, deleteSshKey } = vi.hoisted(() => ({
  listSshKeys: vi.fn(),
  createSshKey: vi.fn(),
  deleteSshKey: vi.fn()
}));

const adminAuthState = {
  user: {
    id: "u1",
    email: "admin@example.com",
    role: "admin" as const,
    tenantId: "t1",
    memberships: [{ tenantId: "t1", tenantName: "Acme", role: "admin" }]
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
    listSshKeys,
    createSshKey,
    deleteSshKey
  }
}));

import { SshKeysPage } from "../src/features/ssh-keys/SshKeysPage.js";

describe("SshKeysPage", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUseAuth = adminAuthState;
    listSshKeys.mockReset();
    createSshKey.mockReset();
    deleteSshKey.mockReset();
    listSshKeys.mockResolvedValue({ keys: [] });
  });

  it("renders empty state and allows opening form", async () => {
    listSshKeys.mockResolvedValue({ keys: [] });
    render(<SshKeysPage />);

    await waitFor(() => {
      expect(screen.getByText("No SSH keys configured yet.")).toBeInTheDocument();
    });

    const addBtn = screen.getByRole("button", { name: "Add Key" });
    fireEvent.click(addBtn);

    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("submits the create form", async () => {
    listSshKeys.mockResolvedValue({ keys: [] });
    createSshKey.mockResolvedValue({});

    render(<SshKeysPage />);

    await waitFor(() => {
      expect(screen.getByText("No SSH keys configured yet.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Key" }));

    const nameInput = screen.getByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "My Key" } });

    const uploadRadio = screen.getByLabelText("Upload Private Key");
    fireEvent.click(uploadRadio);

    const keyInput = screen.getByLabelText("Private Key (PEM format)");
    fireEvent.change(keyInput, { target: { value: "test-pem" } });

    fireEvent.click(screen.getByRole("button", { name: "Create Key" }));

    await waitFor(() => {
      expect(createSshKey).toHaveBeenCalledWith({
        name: "My Key",
        keyType: "uploaded",
        privateKeyPem: "test-pem",
        localPath: undefined
      });
    });
  });

  it("renders keys table", async () => {
    listSshKeys.mockResolvedValue({
      keys: [
        {
          id: "k1",
          name: "Test Key",
          keyType: "uploaded",
          createdAt: new Date().toISOString()
        }
      ]
    });

    render(<SshKeysPage />);

    await waitFor(() => {
      expect(screen.getByText("Test Key")).toBeInTheDocument();
      expect(screen.getByText("Uploaded")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
  });
});
