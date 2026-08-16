import type {
  AppServerNotification,
  ThreadToolInvocationRecord,
} from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  buildToolOutputMetrics,
  detectLargeToolOutput,
  detectNoisyPolling,
  mergeLargeToolOutputIncident,
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
    expect(
      normalizeToolInvocationCommand({
        args: { cell_id: "cell-9", yield_time_ms: 30_000 },
        toolName: "wait",
      }),
    ).toEqual({
      category: "polling",
      normalizedCommand: "wait cell cell-9",
    });
    expect(
      normalizeToolInvocationCommand({
        command: "sleep 30",
        toolName: "commandExecution",
      }),
    ).toEqual({
      category: "polling",
      normalizedCommand: "sleep 30",
    });
  });

  it("redacts secret-like shell command fragments before persistence", () => {
    const normalized = normalizeToolInvocationCommand({
      command:
        "/bin/zsh -lc 'PWRAGENT_TEST_TOKEN=sk-secret pnpm test --token abc123 --password hunter2'",
      toolName: "exec_command",
    });

    expect(normalized).toEqual({
      category: "build-test",
      normalizedCommand:
        "PWRAGENT_TEST_TOKEN=[redacted] pnpm test --token [redacted] --password [redacted]",
    });
    expect(normalized.normalizedCommand).not.toContain("sk-secret");
    expect(normalized.normalizedCommand).not.toContain("abc123");
    expect(normalized.normalizedCommand).not.toContain("hunter2");
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

  it.each([
    {
      field: "aggregatedOutput",
      nestedInData: false,
      shape: "item.aggregatedOutput",
    },
    {
      field: "aggregated_output",
      nestedInData: false,
      shape: "item.aggregated_output",
    },
    {
      field: "functionCallOutput",
      nestedInData: false,
      shape: "item.functionCallOutput",
    },
    {
      field: "aggregatedOutput",
      nestedInData: true,
      shape: "item.data.aggregatedOutput",
    },
    {
      field: "aggregated_output",
      nestedInData: true,
      shape: "item.data.aggregated_output",
    },
  ] as const)(
    "extracts completed Codex command output from $shape",
    ({ field, nestedInData }) => {
      const output = [
        "[info] command started",
        "[warn] retrying step",
        "[debug] retry detail",
        "[error] command failed",
        "output clipped",
      ].join("\n");
      const invocation = toolInvocationFromNotification({
        backend: "codex",
        now: 1_800_000_030_000,
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "cmd-1",
              type: "commandExecution",
              status: "completed",
              ...(nestedInData
                ? { data: { [field]: output } }
                : { [field]: output }),
            },
          },
        } as unknown as AppServerNotification,
      });

      expect(invocation).toMatchObject({
        debugLines: 1,
        errorLines: 1,
        estimatedOutputTokens: Math.ceil(output.length / 4),
        infoLines: 1,
        outputChars: output.length,
        outputLines: 5,
        outputTruncated: true,
        status: "completed",
        warningLines: 1,
      });
    },
  );

  it.each([
    {
      label: "structured object result",
      result: {
        tabs: [{ title: "x".repeat(20_100) }],
      },
    },
    {
      label: "MCP content array",
      result: {
        content: [{ type: "text", text: "x".repeat(20_100) }],
      },
    },
  ])("accounts a large $label", ({ result }) => {
    const invocation = toolInvocationFromNotification({
      backend: "codex",
      now: 1_800_000_030_000,
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "mcp-1",
            type: "mcpToolCall",
            server: "playwright",
            tool: "browser_tabs",
            status: "completed",
            arguments: { action: "list" },
            result,
          },
        },
      } as AppServerNotification,
    });

    expect(invocation).toMatchObject({
      outputChars: JSON.stringify(result).length,
      status: "completed",
      toolName: "browser_tabs",
    });
    expect(detectLargeToolOutput({ current: invocation! })?.alert).toMatchObject({
      kind: "large-output",
      severity: "warning",
      toolName: "browser_tabs",
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

  it("accounts deferred wait function calls as polling", () => {
    const invocation = toolInvocationFromNotification({
      backend: "codex",
      now: 1_800_000_030_000,
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "wait-1",
            type: "functionCall",
            name: "wait",
            status: "completed",
            arguments: { cell_id: "cell-9", yield_time_ms: 30_000 },
            functionCallOutput: "still running",
          },
        },
      } as AppServerNotification,
    });

    expect(invocation).toMatchObject({
      category: "polling",
      normalizedCommand: "wait cell cell-9",
      outputChars: 13,
      sessionId: "cell-9",
      toolName: "wait",
      turnId: "turn-1",
    });
  });

  it("detects five low-output write_stdin polls against one process session", () => {
    const records = [
      buildPollingInvocation("tool-1", 1_800_000_000_000, 0),
      buildPollingInvocation("tool-2", 1_800_000_030_000, 0),
      buildPollingInvocation("tool-3", 1_800_000_060_000, 0),
      buildPollingInvocation("tool-4", 1_800_000_090_000, 0),
      buildPollingInvocation("tool-5", 1_800_000_120_000, 0),
    ];

    const detection = detectNoisyPolling({
      current: records[4]!,
      now: records[4]!.observedAt,
      recent: records.slice(0, 4),
    });

    expect(detection?.invocationIds).toEqual([
      "tool-1",
      "tool-2",
      "tool-3",
      "tool-4",
      "tool-5",
    ]);
    expect(detection?.alert).toMatchObject({
      estimatedOutputTokens: 0,
      invocationCount: 5,
      kind: "noisy-polling",
      sessionId: "40500",
      totalOutputChars: 0,
    });
    expect(detection?.alert.suggestedPrompt).toContain(
      "create_monitor_delegation",
    );
  });

  it("groups deferred waits by turn even when each check has a new cell", () => {
    const records = Array.from({ length: 5 }, (_, index) => ({
      ...buildPollingInvocation(
        `wait-${index + 1}`,
        1_800_000_000_000 + index * 30_000,
        12,
      ),
      normalizedCommand: `wait cell cell-${index + 1}`,
      sessionId: `cell-${index + 1}`,
      toolName: "wait",
      turnId: "turn-1",
    }));

    const detection = detectNoisyPolling({
      current: records[4]!,
      now: records[4]!.observedAt,
      recent: records.slice(0, 4),
    });

    expect(detection?.alert).toMatchObject({
      invocationCount: 5,
      kind: "noisy-polling",
      toolName: "wait",
      turnId: "turn-1",
    });
  });

  it("detects repeated shell sleeps as queued checks in one turn", () => {
    const records = Array.from({ length: 5 }, (_, index) => ({
      ...buildPollingInvocation(
        `sleep-${index + 1}`,
        1_800_000_000_000 + index * 30_000,
        0,
      ),
      normalizedCommand: "sleep 30",
      sessionId: undefined,
      toolName: "commandExecution",
      turnId: "turn-1",
    }));

    const detection = detectNoisyPolling({
      current: records[4]!,
      now: records[4]!.observedAt,
      recent: records.slice(0, 4),
    });

    expect(detection?.alert).toMatchObject({
      invocationCount: 5,
      kind: "noisy-polling",
      toolName: "commandExecution",
      turnId: "turn-1",
    });
  });

  it("detects output at half of the observed cap and escalates at the cap", () => {
    const warning = detectLargeToolOutput({
      current: buildOutputInvocation(20_000),
      previousOutputChars: 19_999,
    });
    const critical = detectLargeToolOutput({
      current: buildOutputInvocation(40_000),
      previousOutputChars: 39_999,
    });

    expect(warning?.alert).toMatchObject({
      kind: "large-output",
      severity: "warning",
      totalOutputChars: 20_000,
    });
    expect(critical?.alert).toMatchObject({
      kind: "large-output",
      severity: "critical",
      totalOutputChars: 40_000,
    });
  });

  it("uses the configured percentage of the output cap", () => {
    const policy = {
      outputCapHitsEnabled: true,
      repeatedLargeOutputsEnabled: true,
      repeatedLargeOutputMinimumCalls: 3,
      repeatedLargeOutputMinimumPercent: 75,
      repeatedQueuedChecksEnabled: true,
    };

    expect(detectLargeToolOutput({
      current: buildOutputInvocation(29_999),
      policy,
    })).toBeUndefined();
    expect(detectLargeToolOutput({
      current: buildOutputInvocation(30_000),
      policy,
    })?.alert).toMatchObject({
      severity: "warning",
      totalOutputChars: 30_000,
    });
  });

  it("waits for five large outputs before notifying", () => {
    let aggregate: ReturnType<typeof mergeLargeToolOutputIncident>["aggregate"]
      | undefined;
    for (let index = 0; index < 5; index += 1) {
      const detection = detectLargeToolOutput({
        current: {
          ...buildOutputInvocation(20_000),
          invocationId: `command-${index + 1}`,
          itemId: `command-${index + 1}`,
        },
      })!;
      const incident = mergeLargeToolOutputIncident({
        current: aggregate,
        detection,
        minimumWarningInvocationCount: 5,
      });
      expect(incident.shouldNotify).toBe(index === 4);
      aggregate = incident.aggregate;
    }
  });

  it("lets operators disable cap-hit and repeated-output alerts independently", () => {
    expect(detectLargeToolOutput({
      current: buildOutputInvocation(40_000),
      policy: {
        outputCapHitsEnabled: false,
        repeatedLargeOutputsEnabled: false,
        repeatedLargeOutputMinimumCalls: 5,
        repeatedLargeOutputMinimumPercent: 50,
        repeatedQueuedChecksEnabled: true,
      },
    })).toBeUndefined();
    expect(detectLargeToolOutput({
      current: buildOutputInvocation(40_000),
      policy: {
        outputCapHitsEnabled: false,
        repeatedLargeOutputsEnabled: true,
        repeatedLargeOutputMinimumCalls: 5,
        repeatedLargeOutputMinimumPercent: 50,
        repeatedQueuedChecksEnabled: true,
      },
    })?.alert.severity).toBe("warning");
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

  it("aggregates cases by turn and keeps a stable worst-case summary", () => {
    const first = detectLargeToolOutput({
      current: buildOutputInvocation(20_000),
      previousOutputChars: 0,
    })!;
    const firstIncident = mergeLargeToolOutputIncident({ detection: first });
    const second = detectLargeToolOutput({
      current: {
        ...buildOutputInvocation(24_000),
        invocationId: "command-2",
        itemId: "command-2",
      },
      previousOutputChars: 0,
    })!;
    const secondIncident = mergeLargeToolOutputIncident({
      current: firstIncident.aggregate,
      detection: second,
    });

    expect(secondIncident.shouldNotify).toBe(true);
    expect(secondIncident.aggregate.alert).toMatchObject({
      invocationCount: 2,
      totalOutputChars: 44_000,
      worstInvocationId: "command-2",
      worstOutputChars: 24_000,
    });
  });

  it("does not rewrite a live warning at terminal completion", () => {
    const live = detectLargeToolOutput({
      current: buildOutputInvocation(20_000),
      previousOutputChars: 0,
    })!;
    const incident = mergeLargeToolOutputIncident({ detection: live });
    const terminal = detectLargeToolOutput({
      current: { ...buildOutputInvocation(20_000), status: "completed" },
    })!;
    const completed = mergeLargeToolOutputIncident({
      current: incident.aggregate,
      detection: terminal,
    });

    expect(completed.shouldNotify).toBe(false);
  });

  it("aggregates repeated polling cases under the turn and alert kind", () => {
    const records = Array.from({ length: 6 }, (_, index) => ({
      ...buildPollingInvocation(
        `wait-${index + 1}`,
        1_800_000_000_000 + index * 30_000,
        (index + 1) * 10,
      ),
      normalizedCommand: undefined,
      sessionId: undefined,
      toolName: "wait",
      turnId: "turn-1",
    }));
    const firstDetection = detectNoisyPolling({
      current: records[4]!,
      now: records[4]!.observedAt,
      recent: records.slice(0, 4),
    })!;
    const firstIncident = mergeLargeToolOutputIncident({
      detection: firstDetection,
    });
    const secondIncident = mergeLargeToolOutputIncident({
      current: firstIncident.aggregate,
      detection: detectNoisyPolling({
        current: records[5]!,
        now: records[5]!.observedAt,
        recent: records.slice(0, 5),
      })!,
    });

    expect(secondIncident.aggregate.alert).toMatchObject({
      alertId: "noisy-polling:codex:thread-1:turn-1",
      invocationCount: 6,
      totalOutputChars: 210,
      worstInvocationId: "wait-6",
      worstOutputChars: 60,
    });
  });

  it("reopens a case only when it escalates to critical", () => {
    const warning = mergeLargeToolOutputIncident({
      detection: detectLargeToolOutput({
        current: buildOutputInvocation(20_000),
        previousOutputChars: 0,
      })!,
    });
    const critical = mergeLargeToolOutputIncident({
      current: warning.aggregate,
      detection: detectLargeToolOutput({
        current: buildOutputInvocation(40_000),
        previousOutputChars: 20_000,
      })!,
    });

    expect(critical.shouldNotify).toBe(true);
    expect(critical.aggregate.alert.severity).toBe("critical");
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

function buildOutputInvocation(outputChars: number): ThreadToolInvocationRecord {
  return {
    ...buildPollingInvocation("command-1", 1_800_000_000_000, outputChars, "shell"),
    estimatedOutputTokens: Math.ceil(outputChars / 4),
    normalizedCommand: "pnpm test",
    outputLines: 500,
    status: "in_progress",
    toolName: "commandExecution",
    turnId: "turn-1",
  };
}

describe("mcp invocation identity", () => {
  it("categorizes by the protocol item type and keeps the server", () => {
    /* The item declares itself: {type: "mcpToolCall", server, tool}. The
       name-substring fallback filed Context7's `query-docs` under unknown
       while `list_mcp_resources` matched by accident. */
    expect(normalizeToolInvocationCommand({
      itemType: "mcpToolCall",
      server: "context7",
      toolName: "query-docs",
    })).toEqual({
      category: "mcp",
      normalizedCommand: "context7/query-docs",
    });
  });

  it("still categorizes as mcp when the server is not recorded", () => {
    expect(normalizeToolInvocationCommand({
      itemType: "mcpToolCall",
      toolName: "query-docs",
    })).toEqual({ category: "mcp", normalizedCommand: "query-docs" });
  });
});
