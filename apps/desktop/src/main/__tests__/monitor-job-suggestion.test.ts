import { describe, expect, it } from "vitest";
import type { AppServerNotification } from "@pwragent/shared";
import {
  buildMonitorJobHeuristicPrompt,
  MonitorJobHeuristicDetector,
  MonitorJobSuggestionDetector,
  parseMonitorJobHeuristicDecision,
} from "../app-server/monitor-job-suggestion";
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

  it("does not mistake CI repair and PR body verification for repeated polling", () => {
    const detector = new MonitorJobSuggestionDetector();
    const commands = [
      [0, "gh pr view 2535 --repo pwrdrvr/PwrAgent --json headRefName,headRefOid,mergeable,statusCheckRollup"],
      [13_000, "gh run view 37232691352 --repo pwrdrvr/PwrAgent --json status,conclusion,event,headSha,jobs"],
      [19_000, "gh run view 37232691352 --repo pwrdrvr/PwrAgent --job 111525612179 --log-failed > .local/failed.log"],
      [105_000, "gh pr view 2535 --repo pwrdrvr/PwrAgent --json body --jq .body > .local/pr-body.md"],
      [148_000, "gh pr edit 2535 --repo pwrdrvr/PwrAgent --body-file .local/pr-body.md"],
      [153_000, "gh pr view 2535 --repo pwrdrvr/PwrAgent --json url,headRefOid,body"],
    ] as const;
    expect(commands.map(([now, command], index) =>
      detector.observe(record(index, command, "turn-1", now)),
    )).toEqual(commands.map(() => false));
  });

  it.each([
    "gh pr view 123 --repo owner/repo --json body --jq .body",
    "gh pr view 123 --repo owner/repo --json url,headRefOid,body",
  ])("ignores repeated metadata reads: %s", (command) => {
    const detector = new MonitorJobSuggestionDetector();
    expect([0, 1, 2].map((index) => detector.observe(record(index, command))))
      .toEqual([false, false, false]);
  });

  it.each(["closed", "closedAt"])("recognizes repeated PR closure polling with %s", (field) => {
    const detector = new MonitorJobSuggestionDetector();
    const command = `gh pr view 123 --json ${field} --jq .${field}`;
    expect([0, 1, 2, 3].map((index) =>
      detector.observe(record(index, command, "turn-1", index * 15_000)),
    )).toEqual([false, false, true, false]);
  });

  it("counts repeated status queries separately for the same PR", () => {
    const detector = new MonitorJobSuggestionDetector();
    const commands = [
      "gh pr view 123 --repo owner/repo --json statusCheckRollup",
      "gh pr view 123 --repo owner/repo --json mergeable",
      "gh pr view 123 --repo owner/repo --json state",
    ];
    expect(commands.map((command, index) => detector.observe(record(index, command))))
      .toEqual([false, false, false]);
    expect(detector.observe(record(3, commands[0]))).toBe(false);
    expect(detector.observe(record(4, commands[0]))).toBe(true);
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

  it("unwraps Code Mode polling through the ordinary suggestion detector", () => {
    const detector = new MonitorJobSuggestionDetector();
    const polls = [0, 1, 2].map((index) => ({
      ...record(index, undefined, "turn-1", index * 30_000),
      toolName: "exec",
      category: "polling" as const,
      normalizedCommand: "poll session 27324",
    }));
    expect(polls.map((poll) => detector.observe(poll)))
      .toEqual([false, false, true]);
  });

  it("produces one bounded helper review for ambiguous poll-shaped execs", () => {
    const detector = new MonitorJobHeuristicDetector();
    detector.observeAssistantMessage({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      observedAt: 5_000,
      text: "The benchmark is still running; I am checking it again.",
    });
    let evidence;
    for (let index = 0; index < 5; index++) {
      evidence = detector.observeInvocation({
        invocation: {
          ...record(index, undefined, "turn-1", index * 20_000),
          toolName: "exec",
          category: "unknown",
          normalizedCommand: "exec",
        },
        inputPreview: "await checkBenchmarkStatus();",
      }) ?? evidence;
    }
    expect(evidence).toMatchObject({
      signature: "exec:exec",
      invocations: expect.arrayContaining([
        expect.objectContaining({ inputPreview: "await checkBenchmarkStatus();" }),
      ]),
      assistantMessages: [
        expect.objectContaining({ text: expect.stringContaining("still running") }),
      ],
    });
    expect(detector.observeInvocation({
      invocation: {
        ...record(6, undefined, "turn-1", 120_000),
        toolName: "exec",
        category: "unknown",
        normalizedCommand: "exec",
      },
    })).toBeUndefined();
    expect(buildMonitorJobHeuristicPrompt(evidence!))
      .toContain("untrusted evidence");
  });

  it("keeps rapid or varied tool activity out of the helper review", () => {
    const rapid = new MonitorJobHeuristicDetector();
    for (let index = 0; index < 10; index++) {
      expect(rapid.observeInvocation({
        invocation: {
          ...record(index, undefined, "turn-1", index * 1_000),
          toolName: "exec",
          category: "unknown",
          normalizedCommand: "exec",
        },
      })).toBeUndefined();
    }
    const varied = new MonitorJobHeuristicDetector();
    for (let index = 0; index < 10; index++) {
      expect(varied.observeInvocation({
        invocation: {
          ...record(index, undefined, "turn-1", index * 20_000),
          toolName: "exec",
          category: "unknown",
          normalizedCommand: `exec ${index}`,
        },
      })).toBeUndefined();
    }
  });

  it("accepts only complete helper decisions", () => {
    expect(parseMonitorJobHeuristicDecision({
      decision: "suggest_monitor",
      reason: "Repeated status checks.",
    })).toEqual({
      decision: "suggest_monitor",
      reason: "Repeated status checks.",
    });
    expect(parseMonitorJobHeuristicDecision({ decision: "continue" }))
      .toBeUndefined();
  });
});
