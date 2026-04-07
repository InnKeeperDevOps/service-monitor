import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listAgents, listServices } = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listServices: vi.fn()
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
    listAgents,
    listServices
  }
}));

import { AgentsPage } from "../src/features/agents/AgentsPage.js";

describe("AgentsPage", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUseAuth = adminAuthState;
    listAgents.mockReset();
    listServices.mockReset();
    listAgents.mockResolvedValue({ agents: [] });
    listServices.mockResolvedValue({ services: [] });
  });

  it("shows loading then empty copy for admin with link to Settings", async () => {
    listAgents.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ agents: [] }), 30))
    );
    listServices.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ services: [] }), 30))
    );
    render(<AgentsPage />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Connected Agents" })).toBeInTheDocument();
    expect(screen.getByText(/Create an enrollment token in/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#settings");
  });

  it("empty state for viewer asks to contact an administrator", async () => {
    mockUseAuth = viewerAuthState;
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Ask an administrator to create an enrollment token/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("renders table headers and agent row with Live from websocketConnected", async () => {
    const iso = new Date("2024-06-01T12:00:00.000Z").toISOString();
    listAgents.mockResolvedValue({
      agents: [
        {
          id: "agent-1",
          tenantId: "t1",
          name: "Edge",
          version: "2.1.0",
          status: "online",
          lastSeenAt: iso,
          certFingerprint: "aa:bb:cc:dd:ee:ff:00:11",
          allowedCapabilities: ["docker", "compose"],
          websocketConnected: true
        },
        {
          id: "agent-2",
          tenantId: "t1",
          name: null,
          version: null,
          status: "offline",
          lastSeenAt: null,
          websocketConnected: false
        }
      ]
    });
    listServices.mockResolvedValue({
      services: [
        {
          id: "svc-1",
          tenantId: "t1",
          name: "app-a",
          repo: "o/r",
          branch: "main",
          agentId: "agent-1",
          workflowGraphId: null,
          dockerImage: null,
          composePath: null
        }
      ]
    });
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    expect(screen.getByRole("columnheader", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Live" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Certificate" })).toBeInTheDocument();

    const yesBadges = screen.getAllByText("Yes");
    expect(yesBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Edge")).toBeInTheDocument();
    expect(screen.getByText("agent-2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "1" })).toHaveAttribute("href", "#services");
  });
});
