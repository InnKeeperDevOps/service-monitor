import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createEnrollmentToken,
  listEnrollmentTokens,
  deactivateEnrollmentToken,
  deleteEnrollmentToken,
  listServices,
  clipboardWriteText
} = vi.hoisted(() => ({
  createEnrollmentToken: vi.fn(),
  listEnrollmentTokens: vi.fn(),
  deactivateEnrollmentToken: vi.fn(),
  deleteEnrollmentToken: vi.fn(),
  listServices: vi.fn(),
  clipboardWriteText: vi.fn()
}));

vi.mock("../src/lib/api.js", () => ({
  api: {
    createEnrollmentToken,
    listEnrollmentTokens,
    deactivateEnrollmentToken,
    deleteEnrollmentToken,
    listServices
  }
}));

import {
  EnrollmentTokensPanel,
  buildKaiadAgentManifest
} from "../src/features/agents/EnrollmentTokensPanel.js";

describe("EnrollmentTokensPanel", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    createEnrollmentToken.mockReset();
    listEnrollmentTokens.mockReset();
    deactivateEnrollmentToken.mockReset();
    deleteEnrollmentToken.mockReset();
    listServices.mockReset();
    listEnrollmentTokens.mockResolvedValue({ tokens: [] });
    listServices.mockResolvedValue({ services: [] });
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

    render(<EnrollmentTokensPanel />);

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
    render(<EnrollmentTokensPanel />);

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

  it("embeds the selected service id in the start command", async () => {
    listServices.mockResolvedValue({
      services: [
        {
          id: "svc-api-1",
          tenantId: "t1",
          name: "api-server",
          gitRepoUrl: "https://github.com/acme/api.git",
          branch: "main",
          agentId: null
        }
      ]
    });
    createEnrollmentToken.mockResolvedValue({
      id: "tok_meta_svc",
      tenantId: "tenant_1",
      token: "svc-token",
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      usedAt: null,
      revokedAt: null,
      isActive: true
    });

    render(<EnrollmentTokensPanel />);

    const serviceSelect = (await screen.findByLabelText(
      "Service this agent runs"
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "api-server (svc-api-1)" })
      ).toBeInTheDocument();
    });
    fireEvent.change(serviceSelect, { target: { value: "svc-api-1" } });

    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    await screen.findByText("svc-token");
    expect(
      await screen.findByText((text) =>
        text.includes("SM_SERVICE_ID=svc-api-1") &&
        text.includes("SM_ENROLLMENT_TOKEN=svc-token")
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Start command \(bound to svc-api-1\) — Docker/)
    ).toBeInTheDocument();
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

    render(<EnrollmentTokensPanel />);
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

    render(<EnrollmentTokensPanel />);

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

    render(<EnrollmentTokensPanel />);

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

    render(<EnrollmentTokensPanel />);

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

    render(<EnrollmentTokensPanel />);

    const deactivateButton = await screen.findByRole("button", { name: "Deactivate token tok_deactivate_me" });
    fireEvent.click(deactivateButton);

    await waitFor(() => {
      expect(deactivateEnrollmentToken).toHaveBeenCalledWith("tok_deactivate_me");
    });
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("emits the selected runtime in the start command", async () => {
    createEnrollmentToken.mockResolvedValue({
      id: "tok_runtime",
      tenantId: "tenant_1",
      token: "rt-token",
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      usedAt: null,
      revokedAt: null,
      isActive: true
    });

    render(<EnrollmentTokensPanel />);

    const runtimeSelect = (await screen.findByLabelText("Agent runtime")) as HTMLSelectElement;
    fireEvent.change(runtimeSelect, { target: { value: "shell" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    await screen.findByText("rt-token");
    expect(
      await screen.findByText((text) =>
        text.includes("SM_AGENT_RUNTIME_OVERRIDE=shell") &&
        text.includes("SM_ENROLLMENT_TOKEN=rt-token")
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/Start command — Shell/)).toBeInTheDocument();
  });

  it("uses the podman socket env var when podman runtime is selected", async () => {
    createEnrollmentToken.mockResolvedValue({
      id: "tok_podman",
      tenantId: "tenant_1",
      token: "podman-token",
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      usedAt: null,
      revokedAt: null,
      isActive: true
    });

    render(<EnrollmentTokensPanel />);

    const runtimeSelect = (await screen.findByLabelText("Agent runtime")) as HTMLSelectElement;
    fireEvent.change(runtimeSelect, { target: { value: "podman" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    await screen.findByText("podman-token");
    expect(
      await screen.findByText((text) =>
        text.includes("SM_DOCKER_SOCKET=/run/podman/podman.sock") &&
        text.includes("SM_ENROLLMENT_TOKEN=podman-token")
      )
    ).toBeInTheDocument();
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

    render(<EnrollmentTokensPanel />);

    const deleteButton = await screen.findByRole("button", { name: "Delete token tok_active_blocked" });
    expect(deleteButton).toBeDisabled();
  });

  it("switches to the Kubernetes tab and renders KaiadAgent YAML", async () => {
    render(<EnrollmentTokensPanel />);
    const k8sTab = await screen.findByRole("tab", { name: /Kubernetes/ });
    fireEvent.click(k8sTab);
    expect(await screen.findByLabelText("KaiadAgent YAML")).toBeInTheDocument();
    // Form controls from the linux flow should not be present.
    expect(screen.queryByLabelText("Expires at")).not.toBeInTheDocument();
  });
});

describe("buildKaiadAgentManifest", () => {
  it("emits a minimal manifest with sensible defaults", () => {
    const yaml = buildKaiadAgentManifest({});
    expect(yaml).toContain("apiVersion: kaiad.dev/v1alpha1");
    expect(yaml).toContain("kind: KaiadAgent");
    expect(yaml).toContain("name: edge-agent");
    expect(yaml).toContain("namespace: kaiad-system");
    expect(yaml).toContain("autoMint: true");
    expect(yaml).toContain("manages:");
  });

  it("includes serviceId only when provided", () => {
    expect(buildKaiadAgentManifest({})).not.toContain("serviceId:");
    const yaml = buildKaiadAgentManifest({ serviceId: "svc-api-1" });
    expect(yaml).toContain("serviceId: svc-api-1");
  });

  it("uses the host's WSS URL when window is available", () => {
    Object.defineProperty(window, "location", {
      value: new URL("https://panel.dev.kaiad.dev"),
      writable: true,
      configurable: true
    });
    const yaml = buildKaiadAgentManifest({});
    expect(yaml).toContain("realtimeUrl: wss://panel.dev.kaiad.dev/realtime");
  });
});
