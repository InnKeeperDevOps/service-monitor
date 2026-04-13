import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LoginPage } from "../src/features/auth/LoginPage.js";
import { api } from "../src/lib/api.js";

vi.mock("../src/lib/api.js", () => ({
  api: {
    login: vi.fn(),
    getAuthProviders: vi.fn().mockResolvedValue({ providers: [] }),
    getOAuthAuthorizeUrl: vi.fn(),
    handleOAuthCallback: vi.fn()
  }
}));

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    
    // Mock window.location for all tests
    Object.defineProperty(window, "location", {
      value: {
        search: "",
        hash: "",
        pathname: "/",
        reload: vi.fn(),
        href: ""
      },
      writable: true
    });
  });

  it("renders login form", () => {
    render(<LoginPage />);
    expect(screen.getByText("Sign in to continue")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("submits the form successfully", async () => {
    vi.mocked(api.login).mockResolvedValueOnce({ token: "test-token" });

    render(<LoginPage />);
    
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
    
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(api.login).toHaveBeenCalledWith("test@example.com", "password");
      expect(localStorage.getItem("sm_token")).toBe("test-token");
      expect(window.location.hash).toBe("dashboard");
      expect(window.location.reload).toHaveBeenCalled();
    });
  });

  it("shows error when login fails", async () => {
    vi.mocked(api.login).mockRejectedValueOnce(new Error("Invalid credentials"));

    render(<LoginPage />);
    
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
    
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid credentials");
    });
  });

  it("loads and displays auth providers", async () => {
    vi.mocked(api.getAuthProviders).mockResolvedValueOnce({
      providers: [
        { id: "google", name: "Google", provider: "google" }
      ]
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    });
  });

  it("handles OAuth login click", async () => {
    vi.mocked(api.getAuthProviders).mockResolvedValueOnce({
      providers: [
        { id: "google", name: "Google", provider: "google" }
      ]
    });
    vi.mocked(api.getOAuthAuthorizeUrl).mockResolvedValueOnce({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?..."
    });

    render(<LoginPage />);

    const oauthButton = await screen.findByRole("button", { name: "Sign in with Google" });
    fireEvent.click(oauthButton);

    await waitFor(() => {
      expect(api.getOAuthAuthorizeUrl).toHaveBeenCalledWith("google");
      expect(window.location.href).toBe("https://accounts.google.com/o/oauth2/v2/auth?...");
    });
  });

  it("shows error when getting OAuth URL fails", async () => {
    vi.mocked(api.getAuthProviders).mockResolvedValueOnce({
      providers: [
        { id: "google", name: "Google", provider: "google" }
      ]
    });
    vi.mocked(api.getOAuthAuthorizeUrl).mockRejectedValueOnce(new Error("Failed to get URL"));

    render(<LoginPage />);

    const oauthButton = await screen.findByRole("button", { name: "Sign in with Google" });
    fireEvent.click(oauthButton);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to get URL");
    });
  });

  it("handles OAuth callback from URL params successfully", async () => {
    window.location.search = "?code=authcode&state=authstate";
    vi.mocked(api.handleOAuthCallback).mockResolvedValueOnce({ token: "oauth-token" });
    
    // Mock replaceState
    const replaceStateMock = vi.fn();
    window.history.replaceState = replaceStateMock;

    render(<LoginPage />);

    await waitFor(() => {
      expect(api.handleOAuthCallback).toHaveBeenCalledWith("authcode", "authstate");
      expect(localStorage.getItem("sm_token")).toBe("oauth-token");
      expect(replaceStateMock).toHaveBeenCalledWith({}, "", "/");
      expect(window.location.hash).toBe("dashboard");
      expect(window.location.reload).toHaveBeenCalled();
    });
  });

  it("handles OAuth callback error", async () => {
    window.location.search = "?code=authcode&state=authstate";
    vi.mocked(api.handleOAuthCallback).mockRejectedValueOnce(new Error("OAuth callback failed"));

    render(<LoginPage />);

    await waitFor(() => {
      expect(api.handleOAuthCallback).toHaveBeenCalledWith("authcode", "authstate");
      expect(screen.getByRole("alert")).toHaveTextContent("OAuth callback failed");
    });
  });
});
