import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  CodexEnvironmentActionRun,
  CodexThreadEnvironmentRuntime,
} from "@pwragent/shared";
import { afterEach, describe, expect, it } from "vitest";
import { EnvActionAnchorList } from "../Composer";

afterEach(() => {
  cleanup();
});

// Each test uses a unique runId namespace so the module-level
// dismissed-set in Composer.tsx doesn't leak state between tests.
// (The set is intentionally module-level to survive Composer remounts
// during real thread switches; tests just need disjoint identities.)
let runIdCounter = 0;
function uniqueRunId(prefix: string): string {
  runIdCounter += 1;
  return `${prefix}-${runIdCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildRuntime(
  runs: CodexEnvironmentActionRun[],
  environmentName = "PwrAgnt",
): Pick<CodexThreadEnvironmentRuntime, "actionRuns" | "environmentName"> {
  return { actionRuns: runs, environmentName };
}

function buildRun(
  overrides: Partial<CodexEnvironmentActionRun> = {},
): CodexEnvironmentActionRun {
  return {
    runId: overrides.runId ?? uniqueRunId("run"),
    actionId: overrides.actionId ?? "dev",
    actionName: overrides.actionName ?? "Dev",
    command: overrides.command ?? "pnpm dev",
    status: overrides.status ?? "started",
    startedAt: overrides.startedAt ?? Date.now(),
    pid: overrides.pid,
    exitedAt: overrides.exitedAt,
    exitCode: overrides.exitCode,
    exitSignal: overrides.exitSignal,
    durationMs: overrides.durationMs,
    output: overrides.output,
  };
}

describe("EnvActionAnchorList", () => {
  it("renders nothing when runtime is undefined", () => {
    const { container } = render(<EnvActionAnchorList runtime={undefined} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when there are no action runs", () => {
    const { container } = render(
      <EnvActionAnchorList runtime={buildRuntime([])} />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the only run is from before this renderer session (zombie)", () => {
    // A run whose startedAt predates the module's session start is a
    // zombie (the parent didn't survive long enough to mark it exited).
    // The list must hide it categorically — otherwise the user is stuck
    // with an undismissable "running" anchor that they can never clear,
    // which was the PwrAgent-terminated-by-Computer-Use repro.
    const { container } = render(
      <EnvActionAnchorList
        runtime={buildRuntime([
          buildRun({ runId: uniqueRunId("zombie"), status: "started", startedAt: 1 }),
        ])}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders nothing when a legacy run (startedAt=0) would otherwise look 'started'", () => {
    // Regression for the original bug where the renderer filter's
    // `latestActivityAt > 0 && latestActivityAt < sessionStart` guard
    // let runs with missing timestamps through, since `0 > 0` is false.
    const { container } = render(
      <EnvActionAnchorList
        runtime={buildRuntime([
          buildRun({
            runId: uniqueRunId("legacy"),
            status: "started",
            startedAt: 0,
          }),
        ])}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders a fresh, current-session run", () => {
    render(
      <EnvActionAnchorList
        runtime={buildRuntime([
          buildRun({
            runId: uniqueRunId("fresh"),
            status: "started",
            pid: 4242,
          }),
        ])}
      />,
    );
    expect(screen.getByLabelText("Env action running")).toBeInTheDocument();
    expect(screen.getByText(/pid 4242/)).toBeInTheDocument();
  });

  it("renders one anchor per fresh run when multiple are alive on the same thread", () => {
    // Multi-instance regression: two concurrent runs (e.g. Start + Test)
    // should each get their own anchor entry. Before the multi-instance
    // refactor the second would have overwritten the first.
    render(
      <EnvActionAnchorList
        runtime={buildRuntime([
          buildRun({
            runId: uniqueRunId("a"),
            actionId: "start",
            actionName: "Start",
            command: "pnpm start",
            status: "started",
            pid: 1001,
          }),
          buildRun({
            runId: uniqueRunId("b"),
            actionId: "test",
            actionName: "Test",
            command: "pnpm test",
            status: "started",
            pid: 1002,
          }),
        ])}
      />,
    );
    // Two separate anchors with their own running labels.
    expect(screen.getAllByLabelText("Env action running")).toHaveLength(2);
    expect(screen.getByText(/pid 1001/)).toBeInTheDocument();
    expect(screen.getByText(/pid 1002/)).toBeInTheDocument();
  });

  it("filters out zombies while keeping fresh siblings visible", () => {
    // Mixed list: one prior-session zombie, one current-session fresh.
    // The zombie must be hidden; the fresh one must remain.
    render(
      <EnvActionAnchorList
        runtime={buildRuntime([
          buildRun({
            runId: uniqueRunId("zombie"),
            status: "started",
            startedAt: 1, // pre-session
            pid: 9999,
          }),
          buildRun({
            runId: uniqueRunId("fresh"),
            status: "started",
            pid: 7777,
          }),
        ])}
      />,
    );
    expect(screen.getAllByLabelText("Env action running")).toHaveLength(1);
    expect(screen.queryByText(/pid 9999/)).toBeNull();
    expect(screen.getByText(/pid 7777/)).toBeInTheDocument();
  });

  it("hides a run after Dismiss is clicked", () => {
    const runId = uniqueRunId("dismissable");
    render(
      <EnvActionAnchorList
        runtime={buildRuntime([
          buildRun({
            runId,
            status: "failed",
            exitCode: 1,
            startedAt: Date.now(),
            exitedAt: Date.now(),
          }),
        ])}
      />,
    );
    expect(screen.getByLabelText("Env action failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // After dismiss, the anchor disappears from the rendered tree.
    expect(screen.queryByLabelText("Env action failed")).toBeNull();
  });

  it("keeps a dismissed run hidden across re-renders (module-level dismiss set)", () => {
    // Real-world: Composer remounts on thread switch. The module-level
    // dismiss set means a re-mount with the same runId continues to
    // hide it. We simulate the remount by unmounting + re-rendering
    // with the same runtime.
    const runId = uniqueRunId("persistent-dismiss");
    const runtime = buildRuntime([
      buildRun({
        runId,
        status: "exited",
        exitCode: 0,
        startedAt: Date.now(),
        exitedAt: Date.now(),
      }),
    ]);
    const { unmount } = render(<EnvActionAnchorList runtime={runtime} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    unmount();
    // Re-render with the SAME runtime; the dismiss should stick.
    render(<EnvActionAnchorList runtime={runtime} />);
    expect(screen.queryByLabelText("Env action exited")).toBeNull();
  });

  it("does not include exited/failed runs from a prior session", () => {
    // Even if a "finished" run carries timestamps, predating the
    // session means it's already-seen historical state. The cleanup
    // pass on the backend should have shed its output bytes, but the
    // renderer is the last line of defence.
    const { container } = render(
      <EnvActionAnchorList
        runtime={buildRuntime([
          buildRun({
            runId: uniqueRunId("historical"),
            status: "exited",
            exitCode: 0,
            startedAt: 1,
            exitedAt: 2,
          }),
        ])}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("preserves the env-name decoration on the anchor entry", () => {
    render(
      <EnvActionAnchorList
        runtime={buildRuntime(
          [
            buildRun({
              runId: uniqueRunId("named"),
              actionName: "E2E Tests",
              status: "started",
            }),
          ],
          "PwrSnap",
        )}
      />,
    );
    expect(screen.getByText(/E2E Tests · PwrSnap/)).toBeInTheDocument();
  });
});
