import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/api.js")>();
  return {
    ...mod,
    api: {
      ...mod.api,
      getSetupStatus: vi.fn(() =>
        Promise.resolve({ setupRequired: false, version: "0.0.0-test" })
      ),
      listIncidents: vi.fn(() => Promise.resolve({ incidents: [] })),
      listAgents: vi.fn(() => Promise.resolve({ agents: [] })),
      listServices: vi.fn(() => Promise.resolve({ services: [] })),
      me: vi.fn(() =>
        Promise.resolve({
          id: "u1",
          email: "test@example.com",
          role: "admin",
          tenantId: "t1",
          memberships: [
            { tenantId: "t1", tenantName: "Alpha", role: "owner" },
            { tenantId: "t2", tenantName: "Beta", role: "admin" }
          ]
        })
      ),
      logout: vi.fn()
    }
  };
});

import { App } from "../src/app.js";
import { api } from "../src/lib/api.js";

beforeEach(() => {
  window.location.hash = "";
  localStorage.setItem("sm_token", "test-token");
});

describe("web app", () => {
  it("renders sidebar with Kaiad branding", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("Kaiad")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
  });

  it("shows dashboard heading on default route", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
    const headings = screen.getAllByText("Dashboard");
    expect(headings.length).toBeGreaterThanOrEqual(1);
  });

  it("renders navigation links", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("#dashboard");
    expect(hrefs).toContain("#incidents");
    expect(hrefs).toContain("#agents");
    expect(hrefs).toContain("#services");
    expect(hrefs).toContain("#workflows");
    expect(hrefs).toContain("#settings");
  });

  it("shows tenant switcher above logout in the sidebar", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    const select = screen.getByTestId("nav-workspace-select");
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Alpha", "Beta"]);

    const logoutButton = screen.getByRole("button", { name: /logout/i });
    const orderBits = select.compareDocumentPosition(logoutButton);
    expect(orderBits & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("falls back to active tenant when /me omits memberships", async () => {
    vi.mocked(api.me).mockResolvedValueOnce({
      id: "u1",
      email: "test@example.com",
      role: "admin",
      tenantId: "t1",
    } as any);

    render(<App />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    const select = screen.getByTestId("nav-workspace-select") as HTMLSelectElement;
    expect(select.value).toBe("t1");
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["t1"]);
  });

});
