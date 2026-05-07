import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { IncidentsPage } from "../src/features/incidents/IncidentsPage.js";
import { api } from "../src/lib/api.js";
import * as useAuthModule from "../src/lib/useAuth.js";

vi.mock("../src/lib/api.js", () => ({
  api: {
    listIncidents: vi.fn(),
    updateIncidentStatus: vi.fn()
  }
}));

describe("IncidentsPage", () => {
  const mockIncidents = [
    {
      id: "inc-1",
      tenantId: "t-1",
      serviceId: "svc-1",
      fingerprint: "fingerprint1234567890",
      status: "open",
      message: "Test incident message",
      firstSeenAt: "2026-04-12T10:00:00Z",
      lastSeenAt: "2026-04-12T11:00:00Z",
      eventCount: 5
    },
    {
      id: "inc-2",
      tenantId: "t-1",
      serviceId: "svc-1",
      fingerprint: "fingerprint2",
      status: "acknowledged",
      message: "Acknowledged incident",
      firstSeenAt: "2026-04-12T09:00:00Z",
      lastSeenAt: "2026-04-12T09:30:00Z",
      eventCount: 1
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(useAuthModule, "useAuth").mockReturnValue({
      user: { id: "u1", email: "u@e", role: "admin", tenantId: "t1", memberships: [] },
      isViewer: false
    });
  });

  it("shows loading/empty state when no incidents", async () => {
    vi.mocked(api.listIncidents).mockResolvedValueOnce({ incidents: [] });
    render(<IncidentsPage />);
    
    await waitFor(() => {
      expect(screen.getByText("No incidents recorded yet.")).toBeInTheDocument();
    });
  });

  it("renders list of incidents", async () => {
    vi.mocked(api.listIncidents).mockResolvedValueOnce({ incidents: mockIncidents });
    render(<IncidentsPage />);
    
    await waitFor(() => {
      expect(screen.getByText("Test incident message")).toBeInTheDocument();
      expect(screen.getByText("Acknowledged incident")).toBeInTheDocument();
      expect(screen.getByText("open")).toBeInTheDocument();
    });
  });

  it("shows error if fetching incidents fails", async () => {
    vi.mocked(api.listIncidents).mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<IncidentsPage />);
    
    await waitFor(() => {
      expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    });
  });

  it("expands row to show details on click", async () => {
    vi.mocked(api.listIncidents).mockResolvedValueOnce({ incidents: mockIncidents });
    render(<IncidentsPage />);
    
    // Wait for render
    await screen.findByText("Test incident message");
    
    // Click row
    fireEvent.click(screen.getByText("Test incident message"));
    
    await waitFor(() => {
      // Details should be visible
      expect(screen.getByText("fingerprint1234567890")).toBeInTheDocument();
      expect(screen.getByText("View Agents →")).toBeInTheDocument();
    });

    // Click again to collapse
    fireEvent.click(screen.getByText("Test incident message"));
    await waitFor(() => {
      expect(screen.queryByText("fingerprint1234567890")).not.toBeInTheDocument();
    });
  });

  it("handles status change to acknowledged", async () => {
    vi.mocked(api.listIncidents).mockResolvedValueOnce({ incidents: mockIncidents });
    vi.mocked(api.updateIncidentStatus).mockResolvedValueOnce({
      ...mockIncidents[0],
      status: "acknowledged"
    });

    render(<IncidentsPage />);
    
    // Wait for buttons
    const ackButtons = await screen.findAllByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButtons[0]); // Click acknowledge on the first incident

    await waitFor(() => {
      expect(api.updateIncidentStatus).toHaveBeenCalledWith("inc-1", "acknowledged");
    });
  });

  it("handles status change to resolved", async () => {
    vi.mocked(api.listIncidents).mockResolvedValueOnce({ incidents: mockIncidents });
    vi.mocked(api.updateIncidentStatus).mockResolvedValueOnce({
      ...mockIncidents[0],
      status: "resolved"
    });

    render(<IncidentsPage />);
    
    const resButtons = await screen.findAllByRole("button", { name: "Resolve" });
    fireEvent.click(resButtons[0]);

    await waitFor(() => {
      expect(api.updateIncidentStatus).toHaveBeenCalledWith("inc-1", "resolved");
    });
  });

  it("hides actions when user is viewer", async () => {
    vi.spyOn(useAuthModule, "useAuth").mockReturnValue({
      user: { id: "u1", email: "u@e", role: "viewer", tenantId: "t1", memberships: [] },
      isViewer: true
    });
    vi.mocked(api.listIncidents).mockResolvedValueOnce({ incidents: mockIncidents });
    
    render(<IncidentsPage />);
    
    await screen.findByText("Test incident message");
    
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  it("shows error if updating status fails", async () => {
    vi.mocked(api.listIncidents).mockResolvedValueOnce({ incidents: mockIncidents });
    vi.mocked(api.updateIncidentStatus).mockRejectedValueOnce(new Error("Update failed"));

    render(<IncidentsPage />);
    
    const ackButtons = await screen.findAllByRole("button", { name: "Acknowledge" });
    fireEvent.click(ackButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Update failed")).toBeInTheDocument();
    });
  });
});
