import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createEnrollmentToken,
  listEnrollmentTokens,
  getSettings,
  listGithubInstallations,
  syncGithubInstallation,
  clipboardWriteText
} = vi.hoisted(() => ({
  createEnrollmentToken: vi.fn(),
  listEnrollmentTokens: vi.fn(),
  getSettings: vi.fn(),
  listGithubInstallations: vi.fn(),
  syncGithubInstallation: vi.fn(),
  clipboardWriteText: vi.fn()
}));

vi.mock("../src/lib/api.js", () => ({
  api: {
    createEnrollmentToken,
    listEnrollmentTokens,
    getSettings,
    listGithubInstallations,
    syncGithubInstallation,
    updateSettings: vi.fn()
  }
}));

import { SettingsPage } from "../src/features/settings/SettingsPage.js";

describe("SettingsPage enrollment token generation", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    createEnrollmentToken.mockReset();
    listEnrollmentTokens.mockReset();
    getSettings.mockReset();
    listGithubInstallations.mockReset();
    syncGithubInstallation.mockReset();
    listEnrollmentTokens.mockResolvedValue({ tokens: [] });
    getSettings.mockResolvedValue(null);
    listGithubInstallations.mockResolvedValue({ installations: [] });
    syncGithubInstallation.mockResolvedValue({ installationId: 1, accountLogin: "test", appId: 1 });
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
      usedAt: null
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
      usedAt: null
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
});
