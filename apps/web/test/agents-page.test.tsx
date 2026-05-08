import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listAgents, listServices, listEnrollmentTokens, attachServiceToAgent, detachServiceFromAgent } = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listServices: vi.fn(),
  listEnrollmentTokens: vi.fn(),
  attachServiceToAgent: vi.fn(),
  detachServiceFromAgent: vi.fn()
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
    listServices,
    listEnrollmentTokens,
    attachServiceToAgent,
    detachServiceFromAgent,
    // Stubbed so ErrorGroupsSection and useTelemetryStream don't throw when
    // a row is expanded; their behavior is covered by their own tests.
    listErrorGroupsForAgent: vi.fn().mockResolvedValue({ groups: [] }),
    openTelemetryStream: vi.fn(() => ({ close: () => {} }))
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
    listEnrollmentTokens.mockReset();
    attachServiceToAgent.mockReset();
    detachServiceFromAgent.mockReset();
    listAgents.mockResolvedValue({ agents: [] });
    listServices.mockResolvedValue({ services: [] });
    listEnrollmentTokens.mockResolvedValue({ tokens: [] });
  });

  it("shows loading then empty copy for admin pointing to inline enrollment panel", async () => {
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
    expect(screen.getByText(/Use the panel below to create an enrollment token/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Enrollment Tokens/ })).toBeInTheDocument();
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
          gitRepoUrl: "o/r",
          branch: "main",
          agents: [{ agentId: "agent-1" }],
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

  // The "attaches an unbound service to an agent from the expanded row"
  // test was removed alongside the temporary recovery that gates
  // ServicesForAgentSection off (it caused a Chrome lock-up when bound
  // services were rendered). Bindings are still editable from the
  // ServicesPage form — see services-page.test.tsx for that flow.
  // Restore this test when ServicesForAgentSection is re-enabled.
});
