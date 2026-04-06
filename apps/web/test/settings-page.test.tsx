import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createEnrollmentToken,
  listEnrollmentTokens,
  deactivateEnrollmentToken,
  deleteEnrollmentToken,
  getSettings,
  getAuthProviders,
  createOAuthProvider,
  listGithubInstallations,
  syncGithubInstallation,
  getGithubAppSettings,
  updateGithubAppSettings,
  updateSettings,
  clipboardWriteText
} = vi.hoisted(() => ({
  createEnrollmentToken: vi.fn(),
  listEnrollmentTokens: vi.fn(),
  deactivateEnrollmentToken: vi.fn(),
  deleteEnrollmentToken: vi.fn(),
  getSettings: vi.fn(),
  getAuthProviders: vi.fn(),
  createOAuthProvider: vi.fn(),
  listGithubInstallations: vi.fn(),
  syncGithubInstallation: vi.fn(),
  getGithubAppSettings: vi.fn(),
  updateGithubAppSettings: vi.fn(),
  updateSettings: vi.fn(),
  clipboardWriteText: vi.fn()
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

const viewerAuthState = {
  user: {
    id: "u2",
    email: "viewer@example.com",
    role: "viewer" as const,
    tenantId: "t1",
    memberships: [{ tenantId: "t1", tenantName: "Acme", role: "viewer" }]
  },
  role: "viewer" as const,
  isAdmin: false,
  isOperator: false,
  isViewer: true
};

let mockUseAuth = adminAuthState;

vi.mock("../src/lib/useAuth.js", () => ({
  useAuth: () => mockUseAuth
}));

vi.mock("../src/lib/api.js", () => ({
  api: {
    createEnrollmentToken,
    listEnrollmentTokens,
    deactivateEnrollmentToken,
    deleteEnrollmentToken,
    getSettings,
    getAuthProviders,
    createOAuthProvider,
    listGithubInstallations,
    syncGithubInstallation,
    getGithubAppSettings,
    updateGithubAppSettings,
    updateSettings
  }
}));

import { SettingsPage } from "../src/features/settings/SettingsPage.js";

describe("SettingsPage enrollment token generation", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUseAuth = adminAuthState;
    createEnrollmentToken.mockReset();
    listEnrollmentTokens.mockReset();
    deactivateEnrollmentToken.mockReset();
    deleteEnrollmentToken.mockReset();
    getSettings.mockReset();
    getAuthProviders.mockReset();
    createOAuthProvider.mockReset();
    listGithubInstallations.mockReset();
    syncGithubInstallation.mockReset();
    getGithubAppSettings.mockReset();
    updateGithubAppSettings.mockReset();
    updateSettings.mockReset();
    listEnrollmentTokens.mockResolvedValue({ tokens: [] });
    getSettings.mockResolvedValue(null);
    getAuthProviders.mockResolvedValue({ providers: [] });
    listGithubInstallations.mockResolvedValue({ installations: [] });
    syncGithubInstallation.mockResolvedValue({ installationId: 1, accountLogin: "test", appId: 1 });
    getGithubAppSettings.mockResolvedValue({
      appId: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      configurable: true
    });
  });

  it("creates enrollment token from selected expiration datetime", async () => {
    createEnrollmentToken.mockResolvedValue({
      id: "tok_meta_1",
      tenantId: "tenant_1",
      token: "enroll-secret-token",
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      usedAt: null,
      revokedAt: null,
      isActive: true
    });

    const expiration = new Date(Date.now() + 60 * 60 * 1000);
    const year = expiration.getFullYear();
    const month = String(expiration.getMonth() + 1).padStart(2, "0");
    const day = String(expiration.getDate()).padStart(2, "0");
    const hours = String(expiration.getHours()).padStart(2, "0");
    const minutes = String(expiration.getMinutes()).padStart(2, "0");

    render(<SettingsPage />);

    const expiresInput = await screen.findByLabelText("Expires at");
    fireEvent.change(expiresInput, { target: { value: `${year}-${month}-${day}T${hours}:${minutes}` } });

    const generateButton = screen.getByRole("button", { name: "Generate token" });
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(createEnrollmentToken).toHaveBeenCalledTimes(1);
    });
    const calledWithTtl = createEnrollmentToken.mock.calls[0][0]?.ttlSeconds as number;
    expect(calledWithTtl).toBeGreaterThan(3500);
    expect(calledWithTtl).toBeLessThanOrEqual(3600);
    expect(await screen.findByText("enroll-secret-token")).toBeInTheDocument();
    expect(
      await screen.findByText((text) =>
        text.includes("SM_ENROLLMENT_TOKEN=enroll-secret-token")
      )
    ).toBeInTheDocument();
  });

  it("shows validation when expiration is in the past", async () => {
    render(<SettingsPage />);

    const expiresInput = await screen.findByLabelText("Expires at");
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const year = past.getFullYear();
    const month = String(past.getMonth() + 1).padStart(2, "0");
    const day = String(past.getDate()).padStart(2, "0");
    const hours = String(past.getHours()).padStart(2, "0");
    const minutes = String(past.getMinutes()).padStart(2, "0");
    fireEvent.change(expiresInput, { target: { value: `${year}-${month}-${day}T${hours}:${minutes}` } });

    const generateButton = screen.getByRole("button", { name: "Generate token" });
    fireEvent.click(generateButton);

    expect(createEnrollmentToken).not.toHaveBeenCalled();
    expect(await screen.findByText("Expiration must be in the future.")).toBeInTheDocument();
  });

  it("copies generated token to clipboard", async () => {
    createEnrollmentToken.mockResolvedValue({
      id: "tok_meta_2",
      tenantId: "tenant_1",
      token: "copy-me-token",
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      usedAt: null,
      revokedAt: null,
      isActive: true
    });

    render(<SettingsPage />);
    const generateButton = await screen.findByRole("button", { name: "Generate token" });
    fireEvent.click(generateButton);

    await screen.findByText("copy-me-token");
    const copyButton = screen.getByRole("button", { name: "Copy token" });
    fireEvent.click(copyButton);

    expect(clipboardWriteText).toHaveBeenCalledWith("copy-me-token");
    expect(await screen.findByText("Copied token to clipboard.")).toBeInTheDocument();
  });

  it("shows active status for listed tokens", async () => {
    listEnrollmentTokens.mockResolvedValue({
      tokens: [
        {
          id: "tok_active",
          tenantId: "tenant_1",
          createdBy: "user_1",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          usedAt: null,
          revokedAt: null,
          isActive: true
        },
        {
          id: "tok_inactive",
          tenantId: "tenant_1",
          createdBy: "user_2",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          usedAt: null,
          revokedAt: null,
          isActive: false
        }
      ]
    });

    render(<SettingsPage />);

    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(await screen.findByText("Expired")).toBeInTheDocument();
  });

  it("deletes an enrollment token from the table", async () => {
    listEnrollmentTokens.mockResolvedValue({
      tokens: [
        {
          id: "tok_delete_me",
          tenantId: "tenant_1",
          createdBy: "user_1",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          usedAt: null,
          revokedAt: null,
          isActive: false
        }
      ]
    });
    deleteEnrollmentToken.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsPage />);

    const deleteButton = await screen.findByRole("button", { name: "Delete token tok_delete_me" });
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(deleteEnrollmentToken).toHaveBeenCalledWith("tok_delete_me");
    });
    expect(screen.queryByRole("button", { name: "Delete token tok_delete_me" })).not.toBeInTheDocument();
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does not delete token when confirmation is canceled", async () => {
    listEnrollmentTokens.mockResolvedValue({
      tokens: [
        {
          id: "tok_keep_me",
          tenantId: "tenant_1",
          createdBy: "user_1",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          usedAt: null,
          revokedAt: null,
          isActive: false
        }
      ]
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<SettingsPage />);

    const deleteButton = await screen.findByRole("button", { name: "Delete token tok_keep_me" });
    fireEvent.click(deleteButton);

    expect(deleteEnrollmentToken).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Delete token tok_keep_me" })).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("deactivates an active enrollment token", async () => {
    listEnrollmentTokens.mockResolvedValue({
      tokens: [
        {
          id: "tok_deactivate_me",
          tenantId: "tenant_1",
          createdBy: "user_1",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          usedAt: null,
          revokedAt: null,
          isActive: true
        }
      ]
    });
    deactivateEnrollmentToken.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsPage />);

    const deactivateButton = await screen.findByRole("button", { name: "Deactivate token tok_deactivate_me" });
    fireEvent.click(deactivateButton);

    await waitFor(() => {
      expect(deactivateEnrollmentToken).toHaveBeenCalledWith("tok_deactivate_me");
    });
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("disables delete button for active tokens", async () => {
    listEnrollmentTokens.mockResolvedValue({
      tokens: [
        {
          id: "tok_active_blocked",
          tenantId: "tenant_1",
          createdBy: "user_1",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          usedAt: null,
          revokedAt: null,
          isActive: true
        }
      ]
    });

    render(<SettingsPage />);

    const deleteButton = await screen.findByRole("button", { name: "Delete token tok_active_blocked" });
    expect(deleteButton).toBeDisabled();
  });
});

describe("SettingsPage authentication OAuth providers", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUseAuth = adminAuthState;
    createEnrollmentToken.mockReset();
    listEnrollmentTokens.mockReset();
    getSettings.mockReset();
    getAuthProviders.mockReset();
    createOAuthProvider.mockReset();
    listGithubInstallations.mockReset();
    getGithubAppSettings.mockReset();
    updateGithubAppSettings.mockReset();
    updateSettings.mockReset();
    listEnrollmentTokens.mockResolvedValue({ tokens: [] });
    getSettings.mockResolvedValue(null);
    getAuthProviders.mockResolvedValue({ providers: [] });
    listGithubInstallations.mockResolvedValue({ installations: [] });
    getGithubAppSettings.mockResolvedValue({
      appId: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false
    });
  });

  it("lists configured OAuth providers", async () => {
    getAuthProviders.mockResolvedValue({
      providers: [
        { id: "google", name: "Google", provider: "google" },
        { id: "okta", name: "Oidc", provider: "oidc" }
      ]
    });

    render(<SettingsPage />);

    expect(await screen.findByText("Google")).toBeInTheDocument();
    expect(screen.getByText("okta")).toBeInTheDocument();
    expect(screen.getAllByText("google").length).toBe(2);
  });

  it("submits new OAuth provider when admin saves", async () => {
    createOAuthProvider.mockResolvedValue({ ok: true });
    getAuthProviders.mockResolvedValue({ providers: [] });

    render(<SettingsPage />);

    await screen.findByRole("button", { name: "Save provider" });

    fireEvent.change(screen.getByLabelText("Provider id"), { target: { value: "gitlab" } });
    fireEvent.change(screen.getByLabelText("Provider type"), { target: { value: "oidc" } });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "client-id-1" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "secret" } });
    fireEvent.change(screen.getByLabelText("Authorize URL"), {
      target: { value: "https://example.com/oauth/authorize" }
    });
    fireEvent.change(screen.getByLabelText("Token URL"), { target: { value: "https://example.com/oauth/token" } });
    fireEvent.change(screen.getByLabelText("User info URL"), { target: { value: "https://example.com/userinfo" } });
    fireEvent.change(screen.getByLabelText("OAuth scopes"), { target: { value: "openid email" } });

    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => {
      expect(createOAuthProvider).toHaveBeenCalledWith({
        id: "gitlab",
        provider: "oidc",
        clientId: "client-id-1",
        clientSecret: "secret",
        authorizeUrl: "https://example.com/oauth/authorize",
        tokenUrl: "https://example.com/oauth/token",
        userInfoUrl: "https://example.com/userinfo",
        scopes: ["openid", "email"]
      });
    });
  });

  it("hides add-provider form for viewers", async () => {
    mockUseAuth = viewerAuthState;
    getAuthProviders.mockResolvedValue({
      providers: [{ id: "google", name: "Google", provider: "google" }]
    });

    render(<SettingsPage />);

    await screen.findByText("Google");
    expect(screen.queryByRole("button", { name: "Save provider" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Only owners and admins can add or change OAuth providers/i)
    ).toBeInTheDocument();
  });

  it("prefills Google defaults when button is clicked", async () => {
    render(<SettingsPage />);

    await screen.findByRole("button", { name: "Use Google defaults" });
    fireEvent.click(screen.getByRole("button", { name: "Use Google defaults" }));

    expect(screen.getByLabelText("Provider id")).toHaveValue("google");
    expect(screen.getByLabelText("Provider type")).toHaveValue("google");
    expect(screen.getByLabelText("Authorize URL")).toHaveValue("https://accounts.google.com/o/oauth2/v2/auth");
    expect(screen.getByLabelText("Token URL")).toHaveValue("https://oauth2.googleapis.com/token");
    expect(screen.getByLabelText("User info URL")).toHaveValue("https://openidconnect.googleapis.com/v1/userinfo");
    expect(screen.getByLabelText("OAuth scopes")).toHaveValue("openid email profile");
  });
});

describe("SettingsPage GitHub App", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUseAuth = adminAuthState;
    createEnrollmentToken.mockReset();
    listEnrollmentTokens.mockReset();
    getSettings.mockReset();
    getAuthProviders.mockReset();
    createOAuthProvider.mockReset();
    listGithubInstallations.mockReset();
    syncGithubInstallation.mockReset();
    getGithubAppSettings.mockReset();
    updateGithubAppSettings.mockReset();
    updateSettings.mockReset();
    listEnrollmentTokens.mockResolvedValue({ tokens: [] });
    getSettings.mockResolvedValue(null);
    getAuthProviders.mockResolvedValue({ providers: [] });
    listGithubInstallations.mockResolvedValue({ installations: [] });
    syncGithubInstallation.mockResolvedValue({ installationId: 99, accountLogin: "acme-org", appId: 1 });
    getGithubAppSettings.mockResolvedValue({
      appId: "42",
      privateKeyConfigured: true,
      webhookSecretConfigured: true
    });
  });

  it("loads GitHub App settings for admin", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(getGithubAppSettings).toHaveBeenCalled();
    });
    expect(await screen.findByLabelText("GitHub App ID")).toHaveValue("42");
  });

  it("submits GitHub App settings when admin saves", async () => {
    updateGithubAppSettings.mockResolvedValue({ ok: true });
    getGithubAppSettings
      .mockResolvedValueOnce({
        appId: "42",
        privateKeyConfigured: true,
        webhookSecretConfigured: true
      })
      .mockResolvedValueOnce({
        appId: "99",
        privateKeyConfigured: true,
        webhookSecretConfigured: true
      });

    render(<SettingsPage />);
    await screen.findByLabelText("GitHub App ID");
    fireEvent.change(screen.getByLabelText("GitHub App ID"), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Save GitHub App" }));

    await waitFor(() => {
      expect(updateGithubAppSettings).toHaveBeenCalledWith({
        githubAppId: "99",
        githubAppPrivateKeyPem: "",
        githubWebhookSecret: ""
      });
    });
  });

  it("hides GitHub credential form for viewers", async () => {
    mockUseAuth = viewerAuthState;
    render(<SettingsPage />);
    expect(
      await screen.findByText(/Only owners and admins can edit GitHub App credentials/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save GitHub App" })).not.toBeInTheDocument();
  });

  it("syncs installation when Sync now is clicked", async () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText("GitHub installation ID to sync"), { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => {
      expect(syncGithubInstallation).toHaveBeenCalledWith(88);
    });
  });
});


