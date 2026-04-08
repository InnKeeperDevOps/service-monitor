import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("test setup DOM cleanup", () => {
  it("renders a marker that must not leak to the next test", () => {
    render(<div data-testid="setup-cleanup-marker" />);
    expect(screen.getByTestId("setup-cleanup-marker")).toBeInTheDocument();
  });

  it("does not see DOM from the previous test (afterEach cleanup)", () => {
    expect(screen.queryByTestId("setup-cleanup-marker")).not.toBeInTheDocument();
  });
});
