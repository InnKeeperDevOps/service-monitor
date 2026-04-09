import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantSwitcher } from "../src/components/TenantSwitcher.js";
import type { AuthUser } from "../src/lib/useAuth.js";

vi.mock("../src/lib/api.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/api.js")>();
  return {
    ...mod,
    api: {
      ...mod.api,
      switchActiveTenant: vi.fn((tenantId: string) =>
        Promise.resolve({
          id: "u1",
          email: "test@example.com",
          role: "owner",
          tenantId,
          memberships: [
            { tenantId: "t-a", tenantName: "Alpha", role: "owner" },
            { tenantId: "t-b", tenantName: "Beta", role: "owner" }
          ]
        })
      )
    }
  };
});

import { api } from "../src/lib/api.js";

const baseUser: AuthUser = {
  id: "u1",
  email: "test@example.com",
  role: "owner",
  tenantId: "t-a",
  memberships: [
    { tenantId: "t-a", tenantName: "Alpha", role: "owner" },
    { tenantId: "t-b", tenantName: "Beta", role: "owner" }
  ]
};

describe("TenantSwitcher", () => {
  beforeEach(() => {
    vi.mocked(api.switchActiveTenant).mockImplementation((tenantId: string) =>
      Promise.resolve({
        id: "u1",
        email: "test@example.com",
        role: "owner",
        tenantId,
        memberships: [
          { tenantId: "t-a", tenantName: "Alpha", role: "owner" },
          { tenantId: "t-b", tenantName: "Beta", role: "owner" }
        ]
      })
    );
  });

  it("renders a workspace select with sorted tenant names", () => {
    const onUserUpdated = vi.fn();
    render(<TenantSwitcher user={baseUser} onUserUpdated={onUserUpdated} />);
    const sel = screen.getByTestId("nav-workspace-select") as HTMLSelectElement;
    expect(sel.value).toBe("t-a");
    const opts = [...sel.options].map((o) => o.textContent);
    expect(opts).toEqual(["Alpha", "Beta"]);
  });

  it("calls switchActiveTenant and onUserUpdated when selection changes", async () => {
    const onUserUpdated = vi.fn();
    render(<TenantSwitcher user={baseUser} onUserUpdated={onUserUpdated} />);
    fireEvent.change(screen.getByTestId("nav-workspace-select"), { target: { value: "t-b" } });
    expect(api.switchActiveTenant).toHaveBeenCalledWith("t-b");
    await vi.waitFor(() => {
      expect(onUserUpdated).toHaveBeenCalled();
    });
  });

  it("shows loading placeholder when /me has not resolved", () => {
    render(<TenantSwitcher user={baseUser} onUserUpdated={vi.fn()} meResolved={false} />);
    expect(screen.getByTestId("nav-workspace-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-workspace-select")).not.toBeInTheDocument();
  });

  it("shows unavailable message when user is null after /me", () => {
    render(<TenantSwitcher user={null} onUserUpdated={vi.fn()} />);
    expect(screen.getByText(/Workspace unavailable/)).toBeInTheDocument();
  });

  it("uses active tenant as the only option when memberships is empty", () => {
    const user: AuthUser = { ...baseUser, memberships: [] };
    render(<TenantSwitcher user={user} onUserUpdated={vi.fn()} />);
    const sel = screen.getByTestId("nav-workspace-select") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["t-a"]);
  });

  it("surfaces API errors when switching workspace fails", async () => {
    vi.mocked(api.switchActiveTenant).mockRejectedValueOnce(new Error("switch failed"));
    const onUserUpdated = vi.fn();
    render(<TenantSwitcher user={baseUser} onUserUpdated={onUserUpdated} />);
    fireEvent.change(screen.getByTestId("nav-workspace-select"), { target: { value: "t-b" } });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("switch failed");
    });
    expect(onUserUpdated).not.toHaveBeenCalled();
  });
});
