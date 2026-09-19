import type { AppServerThreadActivityDetail, AppServerThreadActivityEntry } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import { activityDetailsMatch } from "../activity-detail-match";
import { appendCommandOutputDelta } from "../../features/thread-detail/live-transcript-activity";

function measure(calls: number, chunks: number) {
  let reads = 0;
  const details: AppServerThreadActivityDetail[] = Array.from({ length: calls }, (_, index) => ({
    get id() { reads += 1; return `call-${index}`; },
    kind: "command",
    label: `fixture ${index}`,
    status: "completed",
    command: { displayCommand: `fixture ${index}`, output: "" },
  }));
  // Replay has all but the final call; the aggregate must remain visible.
  // Reconciliation runs again when output produces a new optimistic entry.
  const candidate = details.slice(0, -1);
  let entry: AppServerThreadActivityEntry = {
    type: "activity", id: "live", summary: `Used ${calls} tools`,
    status: "in_progress", details,
  };
  const started = performance.now();
  for (let index = 0; index < chunks; index += 1) {
    entry = appendCommandOutputDelta(entry, { itemId: `call-${calls - 1}`, delta: "x" });
    expect(activityDetailsMatch(candidate, entry.details, false)).toBe(false);
  }
  const ms = performance.now() - started;
  const count = reads;
  expect(entry.details.at(-1)?.command?.output).toBe("x".repeat(chunks));
  return { calls, chunks, reads: count, ms };
}

describe("tool output stream scaling", () => {
  it("bounds output append and replay-detail reconciliation to linear work per chunk", () => {
    const small = measure(1000, 4);
    const large = measure(2000, 4);
    const twice = measure(2000, 8);
    if (process.env.TOOL_OUTPUT_BENCHMARK === "1") {
      process.stdout.write(`${JSON.stringify({
        small, large, twice,
        historyFactor: large.reads / small.reads,
        chunkFactor: twice.reads / large.reads,
      })}\n`);
    }
    expect(large.reads).toBeLessThanOrEqual(small.reads * 2.1);
    expect(twice.reads).toBeLessThanOrEqual(large.reads * 2);
    expect(large.reads).toBeLessThan(100_000);
  });
});

describe("replay activity detail matching", () => {
  const detail = (id: string, options: Partial<AppServerThreadActivityDetail> = {}): AppServerThreadActivityDetail => ({
    id, kind: "command", label: id, ...options,
  });

  it("preserves ID, optional usage label, command and file-diff matches", () => {
    const candidate = [
      detail("id", { label: "usage" }),
      detail("command", { command: { displayCommand: "fixture" } }),
      detail("diff", { fileDiff: { kind: "update", diff: "patch", additions: 1, removals: 0 } }),
    ];
    expect(activityDetailsMatch(candidate, [detail("id")], false)).toBe(true);
    expect(activityDetailsMatch(candidate, [detail("other", { label: "usage" })], false)).toBe(false);
    expect(activityDetailsMatch(candidate, [detail("other", { label: "usage" })], true)).toBe(true);
    expect(activityDetailsMatch(candidate, [detail("other", { command: { displayCommand: "fixture" } })], false)).toBe(true);
    expect(activityDetailsMatch(candidate, [detail("other", { fileDiff: { kind: "update", diff: "patch", additions: 1, removals: 0 } })], false)).toBe(true);
    expect(activityDetailsMatch(candidate, [detail("other", {
      command: { displayCommand: "different" }, fileDiff: { kind: "update", diff: "patch", additions: 1, removals: 0 },
    })], false)).toBe(false);
    expect(activityDetailsMatch(candidate, [detail("id"), detail("missing")], false)).toBe(false);
    expect(activityDetailsMatch([], [detail("id")], false)).toBe(false);
    expect(activityDetailsMatch(candidate, [], false)).toBe(true);
  });

  it("indexes replacement arrays independently without mutating earlier snapshots", () => {
    const before = [detail("before")];
    const after = [detail("after")];
    expect(activityDetailsMatch(before, [detail("before")], false)).toBe(true);
    expect(activityDetailsMatch(after, [detail("before")], false)).toBe(false);
    expect(activityDetailsMatch(after, [detail("after")], false)).toBe(true);
    expect(activityDetailsMatch(before, [detail("before")], false)).toBe(true);
  });
});
