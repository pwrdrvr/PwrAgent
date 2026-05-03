import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererErrorBoundary } from "../RendererErrorBoundary";

function ThrowingChild() {
  throw new Error("Should have a queue");
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("RendererErrorBoundary", () => {
  it("renders a fallback and reports component stack diagnostics", async () => {
    const reportRendererError = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        reportRendererError,
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <RendererErrorBoundary>
        <ThrowingChild />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Renderer error");
    expect(screen.getByText("Should have a queue")).toBeInTheDocument();

    await waitFor(() => {
      expect(reportRendererError).toHaveBeenCalledWith(
        expect.objectContaining({
          componentStack: expect.stringContaining("ThrowingChild"),
          message: "Should have a queue",
          name: "Error",
          source: "error-boundary",
        }),
      );
    });
  });
});
