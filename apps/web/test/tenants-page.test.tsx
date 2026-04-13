import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TenantsPage } from "../src/features/tenants/TenantsPage.js";
import { api } from "../src/lib/api.js";
import * as useAuthModule from "../src/lib/useAuth.js";

vi.mock("../src/lib/api.js", () => ({
  api: {
    createTenant: vi.fn(),
    deleteTenant: vi.fn(),
    me: vi.fn(),
    logout: vi.fn(),
  },
  meResponseToAuthUser: vi.fn((m) => m),
}));

describe("TenantsPage", () => {
  const onAuthUserUpdated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(useAuthModule, "useAuth").mockReturnValue({
      user: {
        id: "u-1",
        email: "test@example.com",
        role: "admin",
        tenantId: "t-1",
        memberships: [
          { tenantId: "t-1", tenantName: "Primary Tenant", role: "owner" },
          { tenantId: "t-2", tenantName: "Secondary Tenant", role: "viewer" },
        ],
      },
      isViewer: false,
    });
    
    // Mock window.confirm
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("renders memberships", () => {
    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    expect(screen.getByText("Primary Tenant")).toBeInTheDocument();
    expect(screen.getByText("t-1")).toBeInTheDocument();
    expect(screen.getByText("Secondary Tenant")).toBeInTheDocument();
    expect(screen.getByText("t-2")).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.getByText("viewer")).toBeInTheDocument();
  });

  it("can open create tenant form", () => {
    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    fireEvent.click(screen.getByRole("button", { name: "New tenant" }));
    
    expect(screen.getByPlaceholderText("e.g. Acme Platform")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("t-my-org")).toBeInTheDocument();
  });

  it("shows error if creating tenant without name", async () => {
    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    fireEvent.click(screen.getByRole("button", { name: "New tenant" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    
    await waitFor(() => {
      expect(screen.getByText("Name is required.")).toBeInTheDocument();
    });
  });

  it("creates tenant successfully", async () => {
    vi.mocked(api.createTenant).mockResolvedValueOnce({ id: "new-user", email: "e", role: "admin", tenantId: "t-new" });
    
    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    fireEvent.click(screen.getByRole("button", { name: "New tenant" }));
    
    fireEvent.change(screen.getByPlaceholderText("e.g. Acme Platform"), { target: { value: "New Tenant Name" } });
    fireEvent.change(screen.getByPlaceholderText("t-my-org"), { target: { value: "t-new" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(api.createTenant).toHaveBeenCalledWith({ name: "New Tenant Name", tenantId: "t-new" });
      expect(onAuthUserUpdated).toHaveBeenCalled();
      expect(screen.queryByPlaceholderText("e.g. Acme Platform")).not.toBeInTheDocument();
    });
  });

  it("shows error on create failure", async () => {
    vi.mocked(api.createTenant).mockRejectedValueOnce(new Error("Creation failed"));
    
    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    fireEvent.click(screen.getByRole("button", { name: "New tenant" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Acme Platform"), { target: { value: "New Tenant Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText("Creation failed")).toBeInTheDocument();
    });
  });

  it("cancels create form", () => {
    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    fireEvent.click(screen.getByRole("button", { name: "New tenant" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Acme Platform"), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    
    expect(screen.queryByPlaceholderText("e.g. Acme Platform")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New tenant" })).toBeInTheDocument();
  });

  it("can delete tenant as owner", async () => {
    vi.mocked(api.deleteTenant).mockResolvedValueOnce(undefined);
    vi.mocked(api.me).mockResolvedValueOnce({ id: "1", email: "e", role: "admin", tenantId: "t2" });

    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    const deleteBtn = screen.getByRole("button", { name: "Delete tenant Primary Tenant" });
    fireEvent.click(deleteBtn);
    
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
      expect(api.deleteTenant).toHaveBeenCalledWith("t-1");
      expect(api.me).toHaveBeenCalled();
      expect(onAuthUserUpdated).toHaveBeenCalled();
    });
  });

  it("shows error on delete failure", async () => {
    vi.mocked(api.deleteTenant).mockRejectedValueOnce(new Error("Cannot delete active tenant"));

    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    const deleteBtn = screen.getByRole("button", { name: "Delete tenant Primary Tenant" });
    fireEvent.click(deleteBtn);
    
    await waitFor(() => {
      expect(screen.getByText("Cannot delete active tenant")).toBeInTheDocument();
    });
  });

  it("logs out if me request fails after delete", async () => {
    vi.mocked(api.deleteTenant).mockResolvedValueOnce(undefined);
    vi.mocked(api.me).mockRejectedValueOnce(new Error("No user found"));

    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    const deleteBtn = screen.getByRole("button", { name: "Delete tenant Primary Tenant" });
    fireEvent.click(deleteBtn);
    
    await waitFor(() => {
      expect(api.logout).toHaveBeenCalled();
    });
  });

  it("prevents deleting if user cancels confirm", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    
    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    const deleteBtn = screen.getByRole("button", { name: "Delete tenant Primary Tenant" });
    fireEvent.click(deleteBtn);
    
    await waitFor(() => {
      expect(api.deleteTenant).not.toHaveBeenCalled();
    });
  });

  it("does not render delete button for viewers", () => {
    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    
    // viewer role is in t-2
    const viewerRow = screen.getByText("Secondary Tenant").closest("div[style*='display: grid']")!;
    expect(viewerRow.querySelector("button[aria-label='Delete tenant Secondary Tenant']")).toBeNull();
    expect(viewerRow).toHaveTextContent("—");
  });

  it("shows empty state if no memberships", () => {
    vi.spyOn(useAuthModule, "useAuth").mockReturnValue({
      user: { id: "u-1", email: "e", role: "admin", tenantId: "t1", memberships: [] },
      isViewer: false
    });

    render(<TenantsPage onAuthUserUpdated={onAuthUserUpdated} />);
    expect(screen.getByText("No tenant memberships.")).toBeInTheDocument();
  });
});
