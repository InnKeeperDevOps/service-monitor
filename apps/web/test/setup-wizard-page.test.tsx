import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SetupWizardPage } from "../src/features/setup/SetupWizardPage.js";
import { api } from "../src/lib/api.js";

vi.mock("../src/lib/api.js", () => ({
  api: {
    testDatabase: vi.fn(),
    testRedis: vi.fn(),
    getSetupTenants: vi.fn(),
    completeSetup: vi.fn()
  }
}));

describe("SetupWizardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock window.location for reload
    Object.defineProperty(window, "location", {
      value: {
        origin: "http://localhost",
        hash: "",
        reload: vi.fn()
      },
      writable: true
    });
  });

  it("renders welcome step first", () => {
    render(<SetupWizardPage />);
    expect(screen.getByRole("heading", { name: "Welcome to Kaiad" })).toBeInTheDocument();
    expect(screen.getByLabelText("Public Base URL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next →" })).toBeInTheDocument();
  });

  it("can navigate through steps with valid data", async () => {
    vi.mocked(api.testDatabase).mockResolvedValueOnce({ ok: true });
    vi.mocked(api.getSetupTenants).mockResolvedValueOnce({ tenants: [{ id: "t1", name: "Tenant 1" }] });
    vi.mocked(api.testRedis).mockResolvedValueOnce({ ok: true });

    render(<SetupWizardPage />);
    
    // Step 1: Welcome
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    
    // Step 2: Infra
    expect(screen.getByRole("heading", { name: "Infrastructure" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Database URL"), { target: { value: "postgres://db" } });
    fireEvent.change(screen.getByLabelText("Redis URL"), { target: { value: "redis://cache" } });
    
    const testBtns = screen.getAllByRole("button", { name: "Test Connection" });
    fireEvent.click(testBtns[0]); // Test DB
    await waitFor(() => expect(screen.getByText("✓ Connected")).toBeInTheDocument());
    
    fireEvent.click(testBtns[1]); // Test Redis
    await waitFor(() => expect(screen.getAllByText("✓ Connected")).toHaveLength(2));
    
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    // Step 3: Admin
    expect(screen.getByRole("heading", { name: "Admin Account" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@test.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    // Step 4: OAuth
    expect(screen.getByRole("heading", { name: "OAuth Provider" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Enable Google OAuth"));
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "client-id" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "client-secret" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    // Step 5: Webhook Tenant
    expect(screen.getByRole("heading", { name: "Webhook Tenant" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Default Tenant"), { target: { value: "t1" } });
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    // Step 6: K8s
    expect(screen.getByRole("heading", { name: "Kubernetes" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: "kaiad" } });
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    // Step 7: Review & Finish
    expect(screen.getByRole("heading", { name: "Review & Finish" })).toBeInTheDocument();
    
    // Check review data
    expect(screen.getByText("postgres://db")).toBeInTheDocument();
    expect(screen.getByText("admin@test.com")).toBeInTheDocument();
    
    vi.mocked(api.completeSetup).mockResolvedValueOnce({ ok: true, tenantId: "t1", adminEmail: "admin@test.com" });
    fireEvent.click(screen.getByRole("button", { name: "Finish Setup" }));

    await waitFor(() => {
      expect(api.completeSetup).toHaveBeenCalledWith({
        databaseUrl: "postgres://db",
        redisUrl: "redis://cache",
        publicBaseUrl: "http://localhost",
        adminEmail: "admin@test.com",
        adminPassword: "password123",
        googleClientId: "client-id",
        googleClientSecret: "client-secret",
        defaultWebhookTenantId: "t1",
        kubernetesNamespace: "kaiad"
      });
      expect(window.location.hash).toBe("login");
      expect(window.location.reload).toHaveBeenCalled();
    });
  });

  it("can skip optional steps", async () => {
    vi.mocked(api.testDatabase).mockResolvedValueOnce({ ok: true });
    vi.mocked(api.getSetupTenants).mockRejectedValueOnce(new Error("No tenants"));
    vi.mocked(api.testRedis).mockResolvedValueOnce({ ok: true });

    render(<SetupWizardPage />);
    
    // Welcome
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    
    // Infra
    fireEvent.change(screen.getByLabelText("Database URL"), { target: { value: "postgres://db" } });
    fireEvent.change(screen.getByLabelText("Redis URL"), { target: { value: "redis://cache" } });
    
    const testBtns = screen.getAllByRole("button", { name: "Test Connection" });
    fireEvent.click(testBtns[0]);
    await waitFor(() => expect(screen.getByText("✓ Connected")).toBeInTheDocument());
    fireEvent.click(testBtns[1]);
    await waitFor(() => expect(screen.getAllByText("✓ Connected")).toHaveLength(2));
    
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    // Admin
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@test.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    // OAuth - skip
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    // Tenant - skip
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    // K8s - skip
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    // Review
    vi.mocked(api.completeSetup).mockResolvedValueOnce({ ok: true, tenantId: "new", adminEmail: "a" });
    fireEvent.click(screen.getByRole("button", { name: "Finish Setup" }));

    await waitFor(() => {
      expect(api.completeSetup).toHaveBeenCalledWith({
        databaseUrl: "postgres://db",
        redisUrl: "redis://cache",
        publicBaseUrl: "http://localhost",
        adminEmail: "admin@test.com",
        adminPassword: "password123",
        googleClientId: undefined,
        googleClientSecret: undefined,
        defaultWebhookTenantId: undefined,
        kubernetesNamespace: undefined
      });
    });
  });

  it("handles test connection failures", async () => {
    vi.mocked(api.testDatabase).mockRejectedValueOnce(new Error("DB Error"));
    vi.mocked(api.testRedis).mockRejectedValueOnce(new Error("Redis Error"));

    render(<SetupWizardPage />);
    
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    
    fireEvent.change(screen.getByLabelText("Database URL"), { target: { value: "bad-db" } });
    fireEvent.change(screen.getByLabelText("Redis URL"), { target: { value: "bad-redis" } });
    
    const testBtns = screen.getAllByRole("button", { name: "Test Connection" });
    
    fireEvent.click(testBtns[0]);
    await waitFor(() => {
      expect(screen.getByText("✗ DB Error")).toBeInTheDocument();
    });
    
    fireEvent.click(testBtns[1]);
    await waitFor(() => {
      expect(screen.getByText("✗ Redis Error")).toBeInTheDocument();
    });
    
    expect(screen.getByRole("button", { name: "Next →" })).toBeDisabled();
  });

  it("shows completion error", async () => {
    vi.mocked(api.testDatabase).mockResolvedValueOnce({ ok: true });
    vi.mocked(api.getSetupTenants).mockResolvedValueOnce({ tenants: [] });
    vi.mocked(api.testRedis).mockResolvedValueOnce({ ok: true });

    render(<SetupWizardPage />);
    
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    fireEvent.change(screen.getByLabelText("Database URL"), { target: { value: "db" } });
    fireEvent.change(screen.getByLabelText("Redis URL"), { target: { value: "rd" } });
    const testBtns = screen.getAllByRole("button", { name: "Test Connection" });
    fireEvent.click(testBtns[0]);
    await waitFor(() => expect(screen.getByText("✓ Connected")).toBeInTheDocument());
    fireEvent.click(testBtns[1]);
    await waitFor(() => expect(screen.getAllByText("✓ Connected")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@a.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password" } });
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    fireEvent.click(screen.getByRole("button", { name: "Skip" })); // oauth
    fireEvent.click(screen.getByRole("button", { name: "Skip" })); // tenant
    fireEvent.click(screen.getByRole("button", { name: "Skip" })); // k8s

    vi.mocked(api.completeSetup).mockRejectedValueOnce(new Error("Setup failed on server"));
    fireEvent.click(screen.getByRole("button", { name: "Finish Setup" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Setup failed on server");
    });
  });
});
