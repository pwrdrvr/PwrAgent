import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the `vi.mock` factories below (which vitest lifts above the
// imports) can close over the same spies the assertions read.
const { createRoot, render } = vi.hoisted(() => {
  const render = vi.fn();
  return { render, createRoot: vi.fn(() => ({ render })) };
});

vi.mock("react-dom/client", () => ({ default: { createRoot } }));
vi.mock("../App", () => ({ App: () => null }));
vi.mock("../features/diagnostics/RendererErrorBoundary", () => ({
  RendererErrorBoundary: () => null,
}));
vi.mock("../lib/dev-performance-pruning", () => ({
  installDevPerformancePruning: () => ({ prune: () => 0, stop: () => undefined }),
}));
vi.mock("../lib/renderer-error-reporting", () => ({
  installGlobalRendererErrorHandlers: () => undefined,
}));

describe("renderer entry point", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    createRoot.mockClear();
    render.mockClear();
    vi.resetModules();
  });

  it("creates one React root and renders the shell into it", async () => {
    await import("../main");

    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(createRoot).toHaveBeenCalledWith(document.getElementById("root"));
    expect(render).toHaveBeenCalledTimes(1);
  });

  // Vite's dev server makes every JSX module a self-accepting Fast Refresh
  // boundary, `main.tsx` included. It can't actually refresh (its exports
  // aren't components), so an HMR update re-executes the module body in the
  // live page and only then invalidates. `vi.resetModules()` + re-import is
  // that same re-execution: same document, same #root, fresh module.
  //
  // Before this was guarded, the second evaluation called `createRoot` again
  // and left two roots reconciling one container — which is what produced the
  // "You are calling ReactDOMClient.createRoot() on a container that has
  // already been passed to createRoot() before" warning and the burst of
  // `NotFoundError: Failed to execute 'removeChild' on 'Node'` reports in the
  // main log on 2026-08-13.
  it("reuses the existing root when the entry module is re-evaluated", async () => {
    await import("../main");
    vi.resetModules();
    await import("../main");

    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(2);
  });
});
