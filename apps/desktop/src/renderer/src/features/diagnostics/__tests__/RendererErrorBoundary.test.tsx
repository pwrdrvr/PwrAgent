import "@testing-library/jest-dom/vitest";
import { useLayoutEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererErrorBoundary } from "../RendererErrorBoundary";
import { RENDERER_RECOVERY_DELAY_MS } from "../../../../../shared/renderer-recovery";

function ThrowingChild() {
  throw new Error("Should have a queue");
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("RendererErrorBoundary", () => {
  it("recovers after React itself detects a maximum update depth failure", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reportRendererError = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, "pwragent", { configurable: true, value: { reportRendererError } });
    let looping = true;
    function UpdateLoop() {
      const [count, setCount] = useState(0);
      useLayoutEffect(() => {
        if (looping) setCount(count + 1);
      });
      return <p>Update loop stopped at {count}</p>;
    }
    render(<RendererErrorBoundary><UpdateLoop /></RendererErrorBoundary>);
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Maximum update depth exceeded"),
      componentStack: expect.stringContaining("UpdateLoop"),
    }));
    looping = false;
    act(() => vi.advanceTimersByTime(RENDERER_RECOVERY_DELAY_MS));
    expect(screen.getByText("Update loop stopped at 0")).toBeInTheDocument();
  });
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

  it("remounts a transient fault after reporting its stacks", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reportRendererError = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, "pwragent", { configurable: true, value: { reportRendererError } });
    let failing = true;
    function Child() {
      if (failing) throw new Error("transient fault");
      return <p>Recovered UI</p>;
    }
    render(<RendererErrorBoundary><Child /></RendererErrorBoundary>);
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      stack: expect.stringContaining("transient fault"),
      componentStack: expect.stringContaining("Child"),
      recovery: { action: "automatic-remount", attempt: 1, limit: 2 },
    }));
    failing = false;
    act(() => vi.advanceTimersByTime(RENDERER_RECOVERY_DELAY_MS - 1));
    expect(screen.getByRole("alert")).toHaveTextContent("Restoring this window");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Recovered UI")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops a persistent fault after two automatic attempts and keeps manual recovery", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reportRendererError = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, "pwragent", { configurable: true, value: { reportRendererError } });
    let failing = true;
    function Child() {
      if (failing) throw new Error("persistent fault");
      return <p>Recovered manually</p>;
    }
    render(<RendererErrorBoundary><Child /></RendererErrorBoundary>);
    act(() => vi.advanceTimersByTime(RENDERER_RECOVERY_DELAY_MS));
    act(() => vi.advanceTimersByTime(RENDERER_RECOVERY_DELAY_MS));
    expect(screen.getByRole("alert")).toHaveTextContent("Automatic recovery stopped");
    expect(reportRendererError).toHaveBeenLastCalledWith(expect.objectContaining({
      recovery: { action: "stopped", attempt: 2, limit: 2 },
    }));
    const count = reportRendererError.mock.calls.length;
    act(() => vi.advanceTimersByTime(60_000));
    expect(reportRendererError).toHaveBeenCalledTimes(count);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Automatic recovery stopped");
    act(() => vi.advanceTimersByTime(60_000));
    expect(reportRendererError).toHaveBeenCalledTimes(count + 2);
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Recovered manually")).toBeInTheDocument();
  });

  it("does not replenish the budget after a successful remount", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failing = true;
    function Child() {
      if (failing) throw new Error("recurring fault");
      return <p>Healthy</p>;
    }
    const view = render(<RendererErrorBoundary><Child /></RendererErrorBoundary>);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      failing = false;
      act(() => vi.advanceTimersByTime(RENDERER_RECOVERY_DELAY_MS));
      expect(screen.getByText("Healthy")).toBeInTheDocument();
      failing = true;
      view.rerender(<RendererErrorBoundary><Child /></RendererErrorBoundary>);
    }
    expect(screen.getByRole("alert")).toHaveTextContent("Automatic recovery stopped");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels queued recovery when the boundary unmounts", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<RendererErrorBoundary><ThrowingChild /></RendererErrorBoundary>);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
