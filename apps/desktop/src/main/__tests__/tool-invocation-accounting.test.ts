import type { ThreadToolInvocationRecord } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  buildToolOutputMetrics,
  detectNoisyPolling,
  normalizeToolInvocationCommand,
  toolInvocationFromNotification,
} from "../app-server/tool-invocation-accounting";

describe("tool invocation accounting", () => {
  it("normalizes shell commands into durable command categories", () => {
    expect(
      normalizeToolInvocationCommand({
        command: "/bin/zsh -lc 'sbt test'",
        toolName: "exec_command",
      }),
    ).toEqual({
      category: "build-test",
      normalizedCommand: "sbt test",
    });
    expect(
      normalizeToolInvocationCommand({
        command: "rg -n pricing apps/desktop",
        toolName: "exec_command",
      }).category,
    ).toBe("search");
    expect(
      normalizeToolInvocationCommand({
        args: { chars: "", session_id: 40500 },
        toolName: "write_stdin",
      }),
    ).toEqual({
      category: "polling",
      normalizedCommand: "poll session 40500",
    });
    expect(
      normalizeToolInvocationCommand({
        args: { chars: "q", session_id: 40500 },
        toolName: "write_stdin",
      }),
    ).toEqual({
      category: "shell",
      normalizedCommand: "write stdin session 40500",
    });
  });

  it("counts output volume and sbt-style warning/error/info/debug lines", () => {
    const metrics = buildToolOutputMetrics(
      [
        "[info] compiling 12 Scala sources",
        "[warn] deprecated API",
        "[debug] classpath resolved",
        "[error] failed test",
        "Exception in worker",
        "PwrAgent renderer boundary: truncated",
      ].join("\n"),
    );

    expect(metrics).toMatchObject({
      debugLines: 1,
      errorLines: 2,
      infoLines: 1,
      outputLines: 6,
      outputTruncated: true,
      warningLines: 1,
    });
    expect(metrics.outputChars).toBeGreaterThan(80);
    expect(metrics.estimatedOutputTokens).toBe(Math.ceil(metrics.outputChars / 4));
  });

  it("extracts invocation stats from normalized live tool notifications", () => {
    const invocation = toolInvocationFromNotification({
      backend: "codex",
      now: 1_800_000_030_000,
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-1",
            type: "commandExecution",
            status: "completed",
            name: "write_stdin",
            arguments: { session_id: 40500, chars: "", yield_time_ms: 30000 },
            data: {
              output: "[info] still running\n".repeat(300),
            },
          },
        },
      },
    });

    expect(invocation).toMatchObject({
      backend: "codex",
      category: "polling",
      itemId: "tool-1",
      normalizedCommand: "poll session 40500",
      outputLines: 300,
      sessionId: "40500",
      status: "completed",
      threadId: "thread-1",
      toolName: "write_stdin",
      turnId: "turn-1",
    });
  });

  it("marks completed command invocations failed from success false or exit code", () => {
    const successFalseInvocation = toolInvocationFromNotification({
      backend: "codex",
      now: 1_800_000_030_000,
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          item: {
            id: "tool-1",
            type: "commandExecution",
            name: "exec_command",
            success: false,
          },
        },
      },
    });
    const exitCodeInvocation = toolInvocationFromNotification({
      backend: "codex",
      now: 1_800_000_030_000,
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          item: {
            id: "tool-2",
            type: "commandExecution",
            name: "exec_command",
            data: {
              exitCode: 1,
            },
          },
        },
      },
    });

    expect(successFalseInvocation).toMatchObject({
      status: "failed",
    });
    expect(exitCodeInvocation).toMatchObject({
      exitCode: 1,
      status: "failed",
    });
  });

  it("detects repeated noisy write_stdin polling against one process session", () => {
    const records = [
      buildPollingInvocation("tool-1", 1_800_000_000_000, 9_000),
      buildPollingInvocation("tool-2", 1_800_000_030_000, 8_000),
      buildPollingInvocation("tool-3", 1_800_000_060_000, 7_000),
    ];

    const detection = detectNoisyPolling({
      current: records[2]!,
      now: records[2]!.observedAt,
      recent: records.slice(0, 2),
    });

    expect(detection?.invocationIds).toEqual(["tool-1", "tool-2", "tool-3"]);
    expect(detection?.alert).toMatchObject({
      estimatedOutputTokens: 6_000,
      invocationCount: 3,
      kind: "noisy-polling",
      sessionId: "40500",
      totalOutputChars: 24_000,
    });
    expect(detection?.alert.suggestedPrompt).toContain(
      "create_monitor_delegation",
    );
  });

  it("does not flag non-empty stdin writes as polling", () => {
    const records = [
      buildPollingInvocation("tool-1", 1_800_000_000_000, 9_000),
      buildPollingInvocation("tool-2", 1_800_000_030_000, 8_000),
      buildPollingInvocation("tool-3", 1_800_000_060_000, 7_000, "shell"),
    ];

    const detection = detectNoisyPolling({
      current: records[2]!,
      now: records[2]!.observedAt,
      recent: records.slice(0, 2),
    });

    expect(detection).toBeUndefined();
  });
});

function buildPollingInvocation(
  invocationId: string,
  observedAt: number,
  outputChars: number,
  category: ThreadToolInvocationRecord["category"] = "polling",
): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    category,
    debugLines: 0,
    errorLines: 0,
    estimatedOutputTokens: Math.ceil(outputChars / 4),
    infoLines: 0,
    invocationId,
    itemId: invocationId,
    noisy: false,
    normalizedCommand: "poll session 40500",
    observedAt,
    outputChars,
    outputLines: 100,
    outputTruncated: false,
    sessionId: "40500",
    status: "completed",
    threadId: "thread-1",
    toolName: "write_stdin",
    updatedAt: observedAt,
    warningLines: 0,
  };
}
