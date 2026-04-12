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
      docsUrl: "https://docs.acme.com"
    });
    updateSettings.mockImplementation(async (payload) => payload);

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    const docsInput = await screen.findByLabelText("Documentation URL");
    await waitFor(() => {
      expect(docsInput).toHaveValue("https://docs.acme.com");
    });
    fireEvent.change(docsInput, { target: { value: "https://new.docs.acme.com" } });
    await waitFor(() => {
      expect(docsInput).toHaveValue("https://new.docs.acme.com");
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tenant settings" }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "t1",
          docsUrl: "https://new.docs.acme.com"
        })
      );
    });
  });

  it("kill switch posts full tenant payload including empty automation policy", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1",
      docsUrl: "https://docs.acme.com",
      automationPolicy: {
        repos: ["acme/app"],
        branches: ["main"],
        actions: ["create_pr"]
      }
    });
    updateSettings.mockImplementation(async (payload) => payload);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    await screen.findByLabelText("Documentation URL");
    fireEvent.click(screen.getByRole("button", { name: "Kill Switch — Disable All Automation" }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        tenantId: "t1",
        docsUrl: "https://docs.acme.com",
        automationPolicy: { repos: [], branches: [], actions: [] }
      });
    });
  });
});
