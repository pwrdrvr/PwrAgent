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

  it.each([1_000, 5_000, 9_000])("detects sustained polling every %i ms exactly once", (interval) => {
    const detector = new MonitorJobSuggestionDetector();
    const suggestions: number[] = [];
    for (let i = 0; i < 120; i++) {
      if (detector.observe(record(i, undefined, "turn-1", i * interval))) {
        suggestions.push(i * interval);
      }
    }
    expect(suggestions).toEqual([Math.ceil(30_000 / interval) * interval]);
  });

  it("ignores a brief burst, expires it, and detects a later sustained loop", () => {
    const detector = new MonitorJobSuggestionDetector();
    for (let i = 0; i < 120; i++) {
      expect(detector.observe(record(i, undefined, "turn-1", i * 10))).toBe(false);
    }
    const suggestions: number[] = [];
    for (let i = 0; i < 10; i++) {
      const now = 900_000 + i * 5_000;
      if (detector.observe(record(120 + i, undefined, "turn-1", now))) suggestions.push(now);
    }
    expect(suggestions).toEqual([930_000]);
  });

  it("requires three distinct checks and at least 30 seconds for the same target", () => {
    const detector = new MonitorJobSuggestionDetector();
    expect(detector.observe(record(0, undefined, "turn-1", 0))).toBe(false);
    expect(detector.observe(record(0, undefined, "turn-1", 30_000))).toBe(false);
    expect(detector.observe(record(1, undefined, "turn-1", 30_000))).toBe(false);
    expect(detector.observe(record(2, undefined, "turn-1", 30_000))).toBe(true);
  });

  it("keeps sustained evidence per target when checks are interleaved", () => {
    const detector = new MonitorJobSuggestionDetector();
    for (let i = 0; i < 6; i++) {
      expect(detector.observe(record(i * 2, undefined, "turn-1", i * 5_000))).toBe(false);
      expect(detector.observe(record(i * 2 + 1, `gh run view ${1000 + i}`, "turn-1", i * 5_000))).toBe(false);
    }
    expect(detector.observe(record(12, undefined, "turn-1", 30_000))).toBe(true);
  });

  it.each(["wait", "write_stdin", "sleep"])("detects frequent %s calls without output", (toolName) => {
    const detector = new MonitorJobSuggestionDetector();
    const suggestions: number[] = [];
    for (let i = 0; i < 20; i++) {
      const poll = { ...record(i, undefined, "turn-1", i * 5_000),
        toolName, category: "polling" as const, outputChars: 0,
        normalizedCommand: toolName === "wait" ? "wait cell 99" : "poll session 99" };
      if (detector.observe(poll)) suggestions.push(i);
    }
    expect(suggestions).toEqual([6]);
  });

  it("retains valid count evidence when the earliest check expires", () => {
    const detector = new MonitorJobSuggestionDetector();
    expect(detector.observe(record(0, undefined, "turn-1", 0))).toBe(false);
    expect(detector.observe(record(1, undefined, "turn-1", 599_000))).toBe(false);
    expect(detector.observe(record(2, undefined, "turn-1", 600_001))).toBe(false);
    expect(detector.observe(record(3, undefined, "turn-1", 629_000))).toBe(true);
  });

  it("matches full-window evidence across mixed polling cadences and gaps", () => {
    // A full-history reference makes the bounded representation prove the
    // detection rule without reproducing its timestamp-compaction strategy.
    const intervals = [0, 1, 100, 1_000, 5_000, 9_000, 30_000, 120_000, 600_001];
    for (let seed = 1; seed <= 40; seed++) {
      const detector = new MonitorJobSuggestionDetector();
      let random = seed;
      let now = 0;
      let suggested = false;
      const history: number[] = [];
      for (let i = 0; i < 80; i++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        now += intervals[random % intervals.length]!;
        history.push(now);
        const recent = history.filter((time) => now - time <= 600_000);
        const expected: boolean = !suggested && recent.length >= 3 && now - recent[0]! >= 30_000;
        expect(detector.observe(record(i, undefined, "turn-1", now))).toBe(expected);
        suggested ||= expected;
      }
    }
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
