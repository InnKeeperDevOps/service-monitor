import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TenantGithubInstallationSection } from "../src/features/tenants/TenantGithubInstallationSection.js";
import { api } from "../src/lib/api.js";

vi.mock("../src/lib/api.js", () => ({
  api: {
    listGithubInstallations: vi.fn(),
    getGithubAppSettings: vi.fn(),
    syncGithubInstallation: vi.fn()
  }
}));

describe("TenantGithubInstallationSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock window location
    Object.defineProperty(window, "location", {
      value: {
        origin: "http://localhost",
        search: "",
        href: "http://localhost",
        pathname: "/"
      },
      writable: true
    });
    
    // Mock history replaceState
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  });

  it("returns null if tenantActive is false", () => {
    vi.mocked(api.getGithubAppSettings).mockResolvedValueOnce({
      installUrl: null,
      appId: null,
      appSlug: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });
    const { container } = render(
      <TenantGithubInstallationSection tenantActive={false} canManageServerCredentials={true} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("loads installations and settings on mount when tenant active", async () => {
    vi.mocked(api.listGithubInstallations).mockResolvedValueOnce({
      installations: [{ installationId: 123, accountLogin: "acme" }]
    });
    vi.mocked(api.getGithubAppSettings).mockResolvedValueOnce({
      installUrl: "https://github.com/apps/kaiad/installations/new",
      appId: "1",
      appSlug: "kaiad",
      privateKeyConfigured: true,
      webhookSecretConfigured: true
    });

    render(<TenantGithubInstallationSection tenantActive={true} canManageServerCredentials={true} />);

    await waitFor(() => {
      expect(api.listGithubInstallations).toHaveBeenCalled();
      expect(api.getGithubAppSettings).toHaveBeenCalled();
      expect(screen.getByText("123")).toBeInTheDocument();
      expect(screen.getByText("acme")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Install on GitHub" })).toHaveAttribute(
        "href",
        "https://github.com/apps/kaiad/installations/new"
      );
    });
  });

  it("shows alternative text if installUrl is missing for an admin", async () => {
    vi.mocked(api.listGithubInstallations).mockResolvedValueOnce({ installations: [] });
    vi.mocked(api.getGithubAppSettings).mockResolvedValueOnce({
      installUrl: null,
      appId: null,
      appSlug: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });

    render(<TenantGithubInstallationSection tenantActive={true} canManageServerCredentials={true} />);

    await waitFor(() => {
      expect(screen.getByText(/Configure them under Settings/)).toBeInTheDocument();
    });
  });

  it("shows alternative text if installUrl is missing for a non-admin", async () => {
    vi.mocked(api.listGithubInstallations).mockResolvedValueOnce({ installations: [] });
    vi.mocked(api.getGithubAppSettings).mockResolvedValueOnce({
      installUrl: null,
      appId: null,
      appSlug: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });

    render(<TenantGithubInstallationSection tenantActive={true} canManageServerCredentials={false} />);

    await waitFor(() => {
      expect(screen.getByText(/Ask an owner or admin/)).toBeInTheDocument();
    });
  });

  it("syncs installation from URL params on load", async () => {
    window.location.search = "?installation_id=456";
    window.location.href = "http://localhost?installation_id=456";

    vi.mocked(api.listGithubInstallations).mockResolvedValueOnce({ installations: [] });
    vi.mocked(api.getGithubAppSettings).mockResolvedValueOnce({
      installUrl: null,
      appId: null,
      appSlug: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });
    vi.mocked(api.syncGithubInstallation).mockResolvedValueOnce({
      installationId: 456,
      accountLogin: "synced-account",
      appId: 1
    });

    render(<TenantGithubInstallationSection tenantActive={true} canManageServerCredentials={true} />);

    await waitFor(() => {
      expect(api.syncGithubInstallation).toHaveBeenCalledWith(456);
      expect(screen.getByText(/Synced GitHub installation 456/)).toBeInTheDocument();
      expect(screen.getByText("456")).toBeInTheDocument();
      expect(screen.getByText("synced-account")).toBeInTheDocument();
    });
  });

  it("shows error if syncing from URL fails", async () => {
    window.location.search = "?installation_id=456";
    window.location.href = "http://localhost?installation_id=456";

    vi.mocked(api.listGithubInstallations).mockResolvedValueOnce({ installations: [] });
    vi.mocked(api.getGithubAppSettings).mockResolvedValueOnce({
      installUrl: null,
      appId: null,
      appSlug: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });
    vi.mocked(api.syncGithubInstallation).mockRejectedValueOnce(new Error("Sync failed"));

    render(<TenantGithubInstallationSection tenantActive={true} canManageServerCredentials={true} />);

    await waitFor(() => {
      expect(api.syncGithubInstallation).toHaveBeenCalledWith(456);
      expect(screen.getByRole("alert")).toHaveTextContent("Sync failed");
    });
  });

  it("manually syncs installation when valid ID provided", async () => {
    vi.mocked(api.listGithubInstallations).mockResolvedValueOnce({ installations: [] });
    vi.mocked(api.getGithubAppSettings).mockResolvedValueOnce({
      installUrl: null,
      appId: null,
      appSlug: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });
    vi.mocked(api.syncGithubInstallation).mockResolvedValueOnce({
      installationId: 789,
      accountLogin: "manual-sync",
      appId: 1
    });

    render(<TenantGithubInstallationSection tenantActive={true} canManageServerCredentials={true} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
    });

    const input = screen.getByLabelText("GitHub installation ID to sync");
    fireEvent.change(input, { target: { value: "789" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() => {
      expect(api.syncGithubInstallation).toHaveBeenCalledWith(789);
      expect(screen.getByText(/Synced GitHub installation 789/)).toBeInTheDocument();
      expect(screen.getByText("789")).toBeInTheDocument();
      expect(screen.getByText("manual-sync")).toBeInTheDocument();
    });
  });

  it("shows error for invalid manual sync ID", async () => {
    vi.mocked(api.listGithubInstallations).mockResolvedValueOnce({ installations: [] });
    vi.mocked(api.getGithubAppSettings).mockResolvedValueOnce({
      installUrl: null,
      appId: null,
      appSlug: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });

    render(<TenantGithubInstallationSection tenantActive={true} canManageServerCredentials={true} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
    });

    const input = screen.getByLabelText("GitHub installation ID to sync");
    fireEvent.change(input, { target: { value: "invalid" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() => {
      expect(screen.getByText("Enter a positive integer installation ID.")).toBeInTheDocument();
      expect(api.syncGithubInstallation).not.toHaveBeenCalled();
    });
  });

  it("shows manual sync API error", async () => {
    vi.mocked(api.listGithubInstallations).mockResolvedValueOnce({ installations: [] });
    vi.mocked(api.getGithubAppSettings).mockResolvedValueOnce({
      installUrl: null,
      appId: null,
      appSlug: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });
    vi.mocked(api.syncGithubInstallation).mockRejectedValueOnce(new Error("Manual sync failed"));

    render(<TenantGithubInstallationSection tenantActive={true} canManageServerCredentials={true} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
    });

    const input = screen.getByLabelText("GitHub installation ID to sync");
    fireEvent.change(input, { target: { value: "789" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() => {
      expect(screen.getByText("Manual sync failed")).toBeInTheDocument();
    });
  });
});
