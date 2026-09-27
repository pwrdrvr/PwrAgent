import { describe, expect, it } from "vitest";
import type { AppServerNotification } from "@pwragent/shared";
import { MonitorJobSuggestionDetector } from "../app-server/monitor-job-suggestion";
import { toolInvocationFromNotification } from "../app-server/tool-invocation-accounting";

function record(index: number, command = "gh run view 123 --repo owner/repo --json status", turnId = "turn-1", now = index * 120_000) {
  return toolInvocationFromNotification({
    backend: "codex",
    now,
    includeSmallTools: true,
    notification: {
      method: "item/completed",
      params: {
        threadId: "thread-1", turnId,
        item: { id: `cmd-${index}`, type: "commandExecution", command, status: "completed", aggregatedOutput: "queued" },
      },
    } as AppServerNotification,
  })!;
}

describe("monitor job suggestions", () => {
  it("recognizes spaced CI polling and reminds once despite more polls", () => {
    const detector = new MonitorJobSuggestionDetector();
    expect([0, 1, 2, 3, 4].map((i) => detector.observe(record(i)))).toEqual([false, false, true, false, false]);
    expect(detector.observe(record(5, undefined, "turn-2"))).toBe(false);
    expect(detector.observe(record(6, undefined, "turn-2"))).toBe(false);
    expect(detector.observe(record(7, undefined, "turn-2"))).toBe(true);
  });

  it("ignores duplicate boundaries, rapid parallel checks, different targets, and logs", () => {
    const detector = new MonitorJobSuggestionDetector();
    for (let i = 0; i < 5; i++) expect(detector.observe(record(0))).toBe(false);
    for (let i = 1; i < 4; i++) expect(detector.observe(record(i, undefined, "rapid", i * 100))).toBe(false);
    for (let i = 0; i < 4; i++) expect(detector.observe(record(i, `gh run view ${i} --repo owner/repo`, "targets"))).toBe(false);
    for (let i = 0; i < 4; i++) expect(detector.observe(record(i, "gh run view 123 --log-failed", "logs"))).toBe(false);
  });

  it("does not combine different repositories or stale evidence", () => {
    const detector = new MonitorJobSuggestionDetector();
    expect(detector.observe(record(0))).toBe(false);
    expect(detector.observe(record(1))).toBe(false);
    expect(detector.observe(record(2, "gh run view 123 --repo other/repo"))).toBe(false);
    expect(detector.observe(record(3, undefined, "turn-1", 900_000))).toBe(false);
  });

  it("recognizes repeated session polls and sleep commands", () => {
    const detector = new MonitorJobSuggestionDetector();
    expect([0, 1, 2].map((i) => detector.observe(record(i, "sleep 60")))).toEqual([false, false, true]);
    detector.clear("codex", "thread-1");
    const polls = [0, 1, 2].map((i) => ({ ...record(i), category: "polling" as const, toolName: "write_stdin", normalizedCommand: "poll session 99" }));
    expect(polls.map((poll) => detector.observe(poll))).toEqual([false, false, true]);
    detector.clear("codex", "thread-1");
    expect(polls.map((poll) => detector.observe({ ...poll, category: "shell" }))).toEqual([false, false, false]);
  });
});
