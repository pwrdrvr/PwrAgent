import type { ThreadOverlayState } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import { CodexEnvironmentLiveOutput } from "../state/codex-environment-live-output";

const THREAD_KEY = "codex:thread-1";

function overlay(runs: Array<{ runId: string; status: "started" | "exited"; output?: string }>): ThreadOverlayState {
  return {
    backend: "codex",
    threadId: "thread-1",
    executionMode: "default",
    extraLinkedDirectories: [],
    codexEnvironmentRuntime: {
      executionTarget: "local",
      actionRuns: runs.map((run) => ({
        ...run, actionId: "dev", actionName: "Dev", command: "pnpm dev", startedAt: 1,
      })),
    },
  };
}

describe("CodexEnvironmentLiveOutput", () => {
  it("overlays live output on running runs only", () => {
    const live = new CodexEnvironmentLiveOutput();
    live.set(THREAD_KEY, "running", "live tail");
    live.set(THREAD_KEY, "finished", "stale tail");
    const stored = overlay([
      { runId: "running", status: "started", output: "stored" },
      { runId: "finished", status: "exited", output: "final" },
    ]);

    const merged = live.apply(THREAD_KEY, stored);

    expect(merged?.codexEnvironmentRuntime?.actionRuns?.map((run) => run.output))
      .toEqual(["live tail", "final"]);
    expect(stored.codexEnvironmentRuntime?.actionRuns?.[0]?.output).toBe("stored");
  });

  it("returns the same object when nothing applies", () => {
    const live = new CodexEnvironmentLiveOutput();
    const stored = overlay([{ runId: "running", status: "started", output: "same" }]);
    expect(live.apply(THREAD_KEY, stored)).toBe(stored);
    live.set(THREAD_KEY, "running", "same");
    expect(live.apply(THREAD_KEY, stored)).toBe(stored);
    expect(live.apply("codex:other", stored)).toBe(stored);
  });

  it("prunes runs that are no longer running", () => {
    const live = new CodexEnvironmentLiveOutput();
    live.set(THREAD_KEY, "running", "a");
    live.set(THREAD_KEY, "finished", "b");
    live.set(THREAD_KEY, "evicted", "c");

    live.prune(THREAD_KEY, overlay([
      { runId: "running", status: "started" },
      { runId: "finished", status: "exited" },
    ]).codexEnvironmentRuntime);
    expect(live.threadKeys()).toEqual([THREAD_KEY]);

    live.drop(THREAD_KEY, "running");
    expect(live.threadKeys()).toEqual([]);
  });
});
