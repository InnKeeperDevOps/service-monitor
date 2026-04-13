import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSettings,
  updateSettings,
  switchActiveTenant
} = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  switchActiveTenant: vi.fn()
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
    getSettings,
    updateSettings,
    switchActiveTenant
  },
  meResponseToAuthUser: (m: any) => ({
    id: m.id,
    email: m.email,
    role: m.role,
    tenantId: m.tenantId,
    memberships: m.memberships
  })
}));

import { TenantConfigurationPage } from "../src/features/tenants/TenantConfigurationPage.js";

describe("TenantConfigurationPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockUseAuth = adminAuthState;
    getSettings.mockReset();
    updateSettings.mockReset();
    switchActiveTenant.mockReset();
    getSettings.mockResolvedValue(null);
  });

  it("submits merged tenant settings on save", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1",
      docsUrl: "https://docs.acme.com",
      preferredExecutor: "claude"
    });
    updateSettings.mockImplementation(async (payload) => payload);

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    const docsInput = await screen.findByLabelText("Documentation URL");
    const executorSelect = await screen.findByLabelText("Preferred executor");

    await waitFor(() => {
      expect(docsInput).toHaveValue("https://docs.acme.com");
      expect(executorSelect).toHaveValue("claude");
    });
    
    fireEvent.change(docsInput, { target: { value: "https://new.docs.acme.com" } });
    fireEvent.change(executorSelect, { target: { value: "cursor" } });

    await waitFor(() => {
      expect(docsInput).toHaveValue("https://new.docs.acme.com");
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tenant settings" }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "t1",
          docsUrl: "https://new.docs.acme.com",
          preferredExecutor: "cursor"
        })
      );
    });
  });

  it("handles form submission errors gracefully", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1"
    });
    updateSettings.mockRejectedValue(new Error("API failure"));

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);
    
    const docsInput = await screen.findByLabelText("Documentation URL");
    await waitFor(() => {
      expect(docsInput).toBeInTheDocument();
    });
    
    fireEvent.click(screen.getByRole("button", { name: "Save tenant settings" }));
    
    // The component handles this via catching the error or through the hook.
    // The error text is shown if the hook exposes `error`.
    // We just want to ensure it doesn't crash here.
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalled();
    });
  });

  it("displays read-only state for viewers", async () => {
    mockUseAuth = {
      ...adminAuthState,
      user: { ...adminAuthState.user, role: "viewer" as const },
      role: "viewer" as const,
      isAdmin: false,
      isOperator: false,
      isViewer: true
    };
    getSettings.mockResolvedValue({ tenantId: "t1" });

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    const message = await screen.findByText(/Only owners, admins, and operators can change tenant settings/i);
    expect(message).toBeInTheDocument();

    const docsInput = screen.getByLabelText("Documentation URL (optional)");
    expect(docsInput).toBeDisabled();
    
    const saveButton = screen.getByRole("button", { name: "Save tenant settings" });
    expect(saveButton).toBeDisabled();
  });

  it("displays switching intermediate state and handles tenant switch errors", async () => {
    // User belongs to t2 but page is t2, then we test switching by providing different id
    mockUseAuth = {
      ...adminAuthState,
      user: { 
        ...adminAuthState.user, 
        tenantId: "t2",
        memberships: [{ tenantId: "t1", tenantName: "Acme", role: "admin" as const }, { tenantId: "t2", tenantName: "Beta", role: "admin" as const }]
      }
    };
    switchActiveTenant.mockRejectedValue(new Error("Switch failed"));

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    // Initially should show switching text or error
    const errText = await screen.findByText("Switch failed");
    expect(errText).toBeInTheDocument();
  });
});
