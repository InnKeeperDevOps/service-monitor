import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSettings,
  getAuthProviders,
  createOAuthProvider,
  getGithubAppSettings,
  updateGithubAppSettings,
  updateSettings
} = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getAuthProviders: vi.fn(),
  createOAuthProvider: vi.fn(),
  getGithubAppSettings: vi.fn(),
  updateGithubAppSettings: vi.fn(),
  updateSettings: vi.fn()
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
    getSettings,
    getAuthProviders,
    createOAuthProvider,
    getGithubAppSettings,
    updateGithubAppSettings,
    updateSettings
  }
}));

import { SettingsPage } from "../src/features/settings/SettingsPage.js";

describe("SettingsPage authentication OAuth providers", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUseAuth = adminAuthState;
    getSettings.mockReset();
    getAuthProviders.mockReset();
    createOAuthProvider.mockReset();
    getGithubAppSettings.mockReset();
    updateGithubAppSettings.mockReset();
    updateSettings.mockReset();
    getSettings.mockResolvedValue(null);
    getAuthProviders.mockResolvedValue({ providers: [] });
    getGithubAppSettings.mockResolvedValue({
      appId: null,
      appSlug: null,
      installUrl: null,
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
