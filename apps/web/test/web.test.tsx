import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api.js", () => ({
  api: {
    listIncidents: vi.fn(() => Promise.resolve({ incidents: [] })),
    listAgents: vi.fn(() => Promise.resolve({ agents: [] })),
    listServices: vi.fn(() => Promise.resolve({ services: [] })),
    me: vi.fn(() => Promise.resolve({ id: "u1", email: "test@example.com", role: "admin", tenantId: "t1" })),
    logout: vi.fn()
  }
}));

import { App } from "../src/app.js";

beforeEach(() => {
  window.location.hash = "";
  localStorage.setItem("sm_token", "test-token");
});

describe("web app", () => {
  it("renders sidebar with Service Monitor branding", async () => {
    render(<App />);
    expect(screen.getByText("Service Monitor")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
  });

  it("shows dashboard heading on default route", async () => {
    render(<App />);
    const headings = screen.getAllByText("Dashboard");
    expect(headings.length).toBeGreaterThanOrEqual(1);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
  });

  it("renders navigation links", async () => {
    render(<App />);
    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("#dashboard");
    expect(hrefs).toContain("#incidents");
    expect(hrefs).toContain("#agents");
    expect(hrefs).toContain("#services");
    expect(hrefs).toContain("#workflows");
    expect(hrefs).toContain("#settings");
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
  });
});
