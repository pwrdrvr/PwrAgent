import { describe, expect, it } from "vitest";
import {
  applyCodexEnvironmentActionRunUpdate,
  CODEX_ENVIRONMENT_ACTION_RUNS_MAX,
  type CodexEnvironmentActionRun,
  type CodexThreadEnvironmentRuntime,
  readCodexEnvironmentActionRuns,
} from "../index";

function buildRun(
  overrides: Partial<CodexEnvironmentActionRun>,
): CodexEnvironmentActionRun {
  return {
    runId: overrides.runId ?? "r1",
    actionId: overrides.actionId ?? "a1",
    actionName: overrides.actionName ?? "Action 1",
    command: overrides.command ?? "echo",
    status: overrides.status ?? "started",
    startedAt: overrides.startedAt ?? 1_000,
    pid: overrides.pid,
    exitedAt: overrides.exitedAt,
    exitCode: overrides.exitCode,
    exitSignal: overrides.exitSignal,
    durationMs: overrides.durationMs,
    output: overrides.output,
  };
}

describe("readCodexEnvironmentActionRuns", () => {
  it("returns empty when runtime is undefined", () => {
    expect(readCodexEnvironmentActionRuns(undefined)).toEqual([]);
  });

  it("prefers actionRuns when present", () => {
    const runtime: CodexThreadEnvironmentRuntime = {
      environmentId: "env",
      environmentName: "Env",
      executionTarget: "local",
      actionRuns: [buildRun({ runId: "fresh" })],
    };
    expect(readCodexEnvironmentActionRuns(runtime)).toEqual([
      expect.objectContaining({ runId: "fresh" }),
    ]);
  });

  it("synthesises a single-element array from legacy fields when actionRuns is missing", () => {
    const runtime: CodexThreadEnvironmentRuntime = {
      environmentId: "env",
      environmentName: "Env",
      executionTarget: "local",
      actionId: "start-dev",
      actionName: "Start Dev",
      actionCommand: "pnpm dev",
      actionStatus: "started",
      actionPid: 12345,
      actionStartedAt: 1_700_000_000_000,
      actionOutput: "first lines",
    };
    expect(readCodexEnvironmentActionRuns(runtime)).toEqual([
      {
        runId: "legacy:start-dev:1700000000000",
        actionId: "start-dev",
        actionName: "Start Dev",
        command: "pnpm dev",
        status: "started",
        pid: 12345,
        startedAt: 1_700_000_000_000,
        exitedAt: undefined,
        exitCode: undefined,
        exitSignal: undefined,
        durationMs: undefined,
        output: "first lines",
      },
    ]);
  });

  it("returns empty when both actionRuns and legacy fields are missing", () => {
    const runtime: CodexThreadEnvironmentRuntime = {
      environmentId: "env",
      environmentName: "Env",
      executionTarget: "local",
    };
    expect(readCodexEnvironmentActionRuns(runtime)).toEqual([]);
  });
});

describe("applyCodexEnvironmentActionRunUpdate", () => {
  it("appends new runs in order", () => {
    const first = buildRun({ runId: "a", actionId: "a" });
    const second = buildRun({ runId: "b", actionId: "b" });
    const after1 = applyCodexEnvironmentActionRunUpdate([], {
      kind: "append",
      run: first,
    });
    const after2 = applyCodexEnvironmentActionRunUpdate(after1, {
      kind: "append",
      run: second,
    });
    expect(after2.map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("patches the matching runId leaving others unchanged", () => {
    const a = buildRun({ runId: "a", output: "old" });
    const b = buildRun({ runId: "b", output: "old" });
    const next = applyCodexEnvironmentActionRunUpdate([a, b], {
      kind: "patch",
      runId: "b",
      patch: { output: "fresh" },
    });
    expect(next).toEqual([
      expect.objectContaining({ runId: "a", output: "old" }),
      expect.objectContaining({ runId: "b", output: "fresh" }),
    ]);
  });

  it("returns the input unchanged when the patched runId isn't present", () => {
    const a = buildRun({ runId: "a" });
    const result = applyCodexEnvironmentActionRunUpdate([a], {
      kind: "patch",
      runId: "missing",
      patch: { output: "x" },
    });
    expect(result).toEqual([a]);
  });

  it("evicts the oldest non-running entry when the cap is exceeded", () => {
    const runs: CodexEnvironmentActionRun[] = [];
    for (let i = 0; i < CODEX_ENVIRONMENT_ACTION_RUNS_MAX; i += 1) {
      runs.push(buildRun({ runId: `r${i}`, status: i < 3 ? "exited" : "started" }));
    }
    const next = applyCodexEnvironmentActionRunUpdate(runs, {
      kind: "append",
      run: buildRun({ runId: "new", status: "started" }),
    });
    expect(next.length).toBe(CODEX_ENVIRONMENT_ACTION_RUNS_MAX);
    // Oldest non-running (r0) was evicted; r1, r2 (also non-running) remain.
    expect(next.map((r) => r.runId)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
      "r8",
      "r9",
      "new",
    ]);
  });

  it("does not evict running entries even if the cap is exceeded and all are running", () => {
    const runs: CodexEnvironmentActionRun[] = [];
    for (let i = 0; i < CODEX_ENVIRONMENT_ACTION_RUNS_MAX; i += 1) {
      runs.push(buildRun({ runId: `r${i}`, status: "started" }));
    }
    const next = applyCodexEnvironmentActionRunUpdate(runs, {
      kind: "append",
      run: buildRun({ runId: "new", status: "started" }),
    });
    // All entries are "started"; nothing evictable. List grows past cap.
    expect(next.length).toBe(CODEX_ENVIRONMENT_ACTION_RUNS_MAX + 1);
    expect(next.at(-1)?.runId).toBe("new");
  });
});
