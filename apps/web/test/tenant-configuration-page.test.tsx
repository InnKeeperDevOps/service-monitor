import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSettings,
  updateSettings,
  switchActiveTenant,
  getGithubAppSettings,
  listGithubInstallations,
  syncGithubInstallation
} = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  switchActiveTenant: vi.fn(),
  getGithubAppSettings: vi.fn(),
  listGithubInstallations: vi.fn(),
  syncGithubInstallation: vi.fn()
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
    switchActiveTenant,
    getGithubAppSettings,
    listGithubInstallations,
    syncGithubInstallation
  },
  meResponseToAuthUser: (m: {
    id: string;
    email: string;
    role: string;
    tenantId: string;
    memberships: { tenantId: string; tenantName: string; role: string }[];
  }) => ({
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
    getGithubAppSettings.mockReset();
    listGithubInstallations.mockReset();
    syncGithubInstallation.mockReset();
    getSettings.mockResolvedValue(null);
    getGithubAppSettings.mockResolvedValue({
      appId: null,
      appSlug: null,
      installUrl: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });
    listGithubInstallations.mockResolvedValue({ installations: [] });
    syncGithubInstallation.mockResolvedValue({ installationId: 99, accountLogin: "acme-org", appId: 1 });
  });

  it("submits merged tenant settings on save", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1",
      githubRepo: "acme/app",
      defaultBranch: "main"
    });
    updateSettings.mockImplementation(async (payload) => payload);

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    const repoInput = await screen.findByLabelText("GitHub repository");
    await waitFor(() => {
      expect(repoInput).toHaveValue("acme/app");
    });
    fireEvent.change(repoInput, { target: { value: "other/repo" } });
    await waitFor(() => {
      expect(repoInput).toHaveValue("other/repo");
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tenant settings" }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "t1",
          githubRepo: "other/repo",
          defaultBranch: "main"
        })
      );
    });
  });

  it("kill switch posts full tenant payload including empty automation policy", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1",
      githubRepo: "acme/app",
      defaultBranch: "main",
      automationPolicy: {
        repos: ["acme/app"],
        branches: ["main"],
        actions: ["create_pr"]
      }
    });
    updateSettings.mockImplementation(async (payload) => payload);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    await screen.findByLabelText("GitHub repository");
    fireEvent.click(screen.getByRole("button", { name: "Kill Switch — Disable All Automation" }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        tenantId: "t1",
        githubRepo: "acme/app",
        defaultBranch: "main",
        automationPolicy: { repos: [], branches: [], actions: [] }
      });
    });
  });

  it("shows Install on GitHub link when server returns installUrl", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1",
      githubRepo: "acme/app",
      defaultBranch: "main"
    });
    getGithubAppSettings.mockResolvedValue({
      appId: "42",
      appSlug: "acme-kaiad",
      installUrl: "https://github.com/apps/acme-kaiad/installations/new",
      privateKeyConfigured: true,
      webhookSecretConfigured: true
    });
    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);
    const link = await screen.findByRole("link", { name: "Install on GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/apps/acme-kaiad/installations/new");
  });

  it("syncs installation when Sync now is clicked", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1",
      githubRepo: "acme/app",
      defaultBranch: "main"
    });
    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);
    await screen.findByLabelText("GitHub repository");
    fireEvent.change(screen.getByLabelText("GitHub installation ID to sync"), { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => {
      expect(syncGithubInstallation).toHaveBeenCalledWith(88);
    });
  });

  it("shows tenant configuration link to manage repo access on GitHub", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1",
      githubRepo: "acme/app",
      defaultBranch: "main"
    });
    getGithubAppSettings.mockResolvedValue({
      appId: "42",
      appSlug: "acme-kaiad",
      installUrl: "https://github.com/apps/acme-kaiad/installations/new",
      privateKeyConfigured: true,
      webhookSecretConfigured: true
    });

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    const link = await screen.findByRole("link", { name: "Manage repos and permissions on GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/apps/acme-kaiad/installations/new");
  });

  it("shows tenant configuration fallback copy when install link is unavailable", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1",
      githubRepo: "acme/app",
      defaultBranch: "main"
    });
    getGithubAppSettings.mockResolvedValue({
      appId: null,
      appSlug: null,
      installUrl: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    expect(await screen.findByText(/configure github app settings first/i)).toBeInTheDocument();
  });

  it("shows tenant configuration fallback copy when GitHub App settings fetch fails", async () => {
    getSettings.mockResolvedValue({
      tenantId: "t1",
      githubRepo: "acme/app",
      defaultBranch: "main"
    });
    getGithubAppSettings.mockRejectedValue(new Error("github settings unavailable"));

    render(<TenantConfigurationPage tenantIdFromRoute="t1" onAuthUserUpdated={() => {}} />);

    expect(await screen.findByText(/configure github app settings first/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage repos and permissions on GitHub" })).toBeDisabled();
  });
});
