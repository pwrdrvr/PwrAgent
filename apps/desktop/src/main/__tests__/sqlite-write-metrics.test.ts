import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  AppServerThreadReplay,
  AppServerThreadSummary,
  TaskMonitorUsageSnapshot,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { AutomationStore } from "../automations/automation-store";
import { DesktopAutomationService } from "../automations/desktop-automation-service";
import { RuntimeLeaseManager } from "../runtime-lease-manager";
import {
  AppRuntimeInstanceStore,
  RUNTIME_LEASE_DEAD_OWNER_GRACE_MS,
} from "../state/app-runtime-instance-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import {
  measureSqliteWrites,
  readSqliteWriteMetrics,
  resetSqliteWriteMetrics,
  SQLITE_WRITE_METRICS_ENV,
} from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { ComposerDraftRecoveryStore } from "../state/composer-draft-recovery-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

const ALERTING_TOOL_OUTPUT_POLICY = {
  outputCapHitsEnabled: true,
  repeatedLargeOutputsEnabled: true,
  repeatedLargeOutputMinimumCalls: 5,
  repeatedLargeOutputMinimumPercent: 50,
  repeatedQueuedChecksEnabled: true,
};

beforeEach(() => {
  process.env[SQLITE_WRITE_METRICS_ENV] = "1";
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-write-metrics-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
  // The collector is process-wide and this file asserts on exact counts, so
  // each test starts from zero. Ordinary test files do not do this — the
  // vitest setup resets once per file so the report attributes a whole file.
  resetSqliteWriteMetrics();
});

afterEach(() => {
  delete process.env[SQLITE_WRITE_METRICS_ENV];
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("sqlite write metrics", () => {
  it("attributes commits and rows to the table that took them", async () => {
    await store.upsertThreadToolInvocation({
      invocation: buildInvocation("tool-1"),
    });
    await store.upsertThreadToolInvocation({
      invocation: buildInvocation("tool-2"),
    });

    const metrics = readSqliteWriteMetrics();
    expect(metrics?.commits).toBe(2);
    expect(metrics?.rowsChanged).toBe(2);
    expect(
      metrics?.tables.find((table) => table.table === "thread_tool_invocations"),
    ).toMatchObject({ commits: 2, rowsChanged: 2, statements: 2 });
  });

  it("counts a batched transaction as one commit, not one per statement", () => {
    // Write amplification tracks commits, not statements: each implicit
    // transaction flushes its dirty pages plus every index they moved. A
    // report that counted statements would rank a batched migration as
    // expensive and a per-event write loop as cheap — exactly backwards.
    const insert = stateDb.raw.prepare(
      "INSERT INTO thread_tool_invocation_alerts (alert_id, backend, thread_id, "
        + "kind, severity, tool_name, message, suggested_prompt, invocation_count, "
        + "total_output_chars, estimated_output_tokens, average_interval_ms, "
        + "first_observed_at, last_observed_at, created_at, updated_at) "
        + "VALUES (?, 'codex', 'thread-1', 'noisy-polling', 'warning', "
        + "'write_stdin', 'm', 'p', 1, 1, 1, 1, 1, 1, 1, 1)",
    );
    stateDb.raw.transaction(() => {
      for (let index = 0; index < 50; index += 1) {
        insert.run(`batched-${index}`);
      }
    })();

    const metrics = readSqliteWriteMetrics();
    expect(metrics?.statements).toBe(50);
    expect(metrics?.commits).toBe(1);
  });

  it("persists one explicit history analysis in one transaction", async () => {
    const invocations = Array.from({ length: 25 }, (_, index) => ({
      ...buildInvocation(`history-tool-${index}`),
      findingId: `history-tool-${index}`,
      source: "history" as const,
    }));
    // This runs only on an explicit Analyze/Refresh action. Even at 20 manual
    // analyses per day, one commit each is 20 commits/day; findings scale the
    // statements inside the transaction, never the number of WAL flushes.
    const { writes } = await measureSqliteWrites(async () => {
      await store.persistThreadToolHistoryAnalysis({
        backend: "codex",
        coverage: {
          analyzedAt: 1_800_000_000_000,
          analyzerVersion: "1",
          completeness: "complete",
          entryCount: 50,
          invocationCount: invocations.length,
          missingOutputCount: 0,
          pageCount: 2,
          scannedThrough: "oldest-entry",
        },
        invocations,
        threadId: "thread-1",
      });
    });

    expectSqliteWriteBudget({
      note: "replace 25 deterministic history findings plus coverage metadata in one explicit analysis transaction",
      scenario: "tool-output-history-analysis",
      writes,
    });
  });

  it("holds each completed questionnaire transcript record to one commit", async () => {
    // This path runs once per completed questionnaire, never per streamed
    // event. At 100 questionnaires/day, one commit each is 100 commits/day;
    // the measured WAL below keeps the corresponding disk cost reviewable.
    const { writes } = await measureSqliteWrites(async () => {
      await store.appendQuestionnaireActivity({
        backend: "codex",
        threadId: "questionnaire-thread",
        activity: {
          id: "questionnaire:request-1",
          requestId: "request-1",
          threadId: "questionnaire-thread",
          turnId: "turn-1",
          itemId: "input-1",
          status: "submitted",
          createdAt: 1_800_000_000_000,
          updatedAt: 1_800_000_000_000,
          questions: [
            {
              id: "food",
              header: "Food",
              question: "What should breakfast feature?",
              isOther: true,
            },
          ],
          answers: {
            food: { answers: ["Waffles"] },
          },
        },
      });
    });

    expectSqliteWriteBudget({
      note: "persist one completed questionnaire transcript summary",
      scenario: "completed-questionnaire-transcript",
      writes,
    });
  });

  it("keeps the transaction variants callable and counted", () => {
    // better-sqlite3 hangs .default/.deferred/.immediate/.exclusive off the
    // callable it returns, and they are not enumerable. The first version of
    // this wrapper copied with Object.assign and dropped them, so every
    // `tx.immediate(...)` caller died with "is not a function". Instrumentation
    // has to be invisible to the code it measures.
    const insert = stateDb.raw.prepare(
      "INSERT INTO thread_tool_invocations (invocation_id, backend, thread_id, "
        + "item_id, tool_name, category, status, observed_at, updated_at, "
        + "output_chars, output_lines, estimated_output_tokens, warning_lines, "
        + "error_lines, info_lines, debug_lines, output_truncated, noisy) "
        + "VALUES (?, 'codex', 't', 'i', 'commandExecution', 'shell', "
        + "'completed', 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
    );
    const transaction = stateDb.raw.transaction((id: string) => {
      insert.run(id);
    });

    expect(typeof transaction.immediate).toBe("function");
    expect(typeof transaction.deferred).toBe("function");
    expect(typeof transaction.exclusive).toBe("function");

    transaction("plain");
    transaction.immediate("immediate");

    const metrics = readSqliteWriteMetrics();
    expect(metrics?.statements).toBe(2);
    expect(metrics?.commits).toBe(2);
  });

  it("holds streamed command output to one commit per flush window", async () => {
    // The regression guard for PR #1406. Tool accounting used to run one
    // implicit transaction per streamed 8 KiB chunk — 3,693 commits and 58 MB
    // of WAL for a single `find /`. Nothing caught it: every test over that
    // path uses a mocked overlay store, so no sqlite was involved.
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
      resolveToolOutputAlertPolicy: () => ALERTING_TOOL_OUTPUT_POLICY,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    // Everything above is setup and sits outside the measured region, so the
    // budget tracks the streaming path rather than the fixture.
    const { writes } = await measureSqliteWrites(async () => {
      for (let index = 0; index < 500; index += 1) {
        await emit({
          backend: "codex",
          notification: {
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "cmd-1",
              delta: `line ${index}\n`,
            },
          },
        } as AgentEvent);
      }
      await emit({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "cmd-1",
              type: "commandExecution",
              command: "find / -xdev",
              status: "completed",
              exitCode: 0,
            },
          },
        },
      } as AgentEvent);
    });

    expectSqliteWriteBudget({
      note: "500 streamed output deltas plus the completion for one command",
      scenario: "streamed-command-output",
      writes,
    });

    await registry.close();
  });

  it("persists a streamed large-output alert boundary in one commit", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
      resolveToolOutputAlertPolicy: () => ALERTING_TOOL_OUTPUT_POLICY,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    const { writes } = await measureSqliteWrites(async () => {
      for (let index = 0; index < 5; index += 1) {
        await emit({
          backend: "codex",
          notification: {
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: "thread-streaming-alert",
              turnId: "turn-1",
              itemId: `cmd-${index + 1}`,
              delta: "x".repeat(20_100),
            },
          },
        } as AgentEvent);
      }
    });

    expectSqliteWriteBudget({
      note: "five large streamed outputs and their first repeated-output alert",
      scenario: "streamed-large-output-alert-boundary",
      writes,
    });

    const accounting = await store.readThreadToolAccounting({
      backend: "codex",
      threadId: "thread-streaming-alert",
    });
    expect(accounting.alerts).toEqual([
      expect.objectContaining({
        kind: "large-output",
        invocationCount: 5,
        totalOutputChars: 100_500,
      }),
    ]);
    expect(accounting.invocations).toEqual([
      expect.objectContaining({
        noisy: true,
        noisyReason: "large-output",
        outputChars: 20_100,
        status: "in_progress",
      }),
    ]);

    await registry.close();
  });

  it("backfills one discovered native sub-agent in two boundary writes", async () => {
    const nativeThreadId = "thread-epicurus";
    await store.persistThreadUsageActivity({
      backend: "codex",
      threadId: nativeThreadId,
      activity: {
        type: "activity",
        id: "live-turn-usage-turn-epicurus",
        createdAt: 1_800_000_000_000,
        summary:
          "Turn usage: 106,640 uncached in · 2,811,136 cached · 11,224 out (4,269 reasoning)",
        status: "completed",
        details: [],
        turn: {
          id: "turn-epicurus",
          status: "completed",
          completedAt: 1_800_000_000_000,
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient({
        threads: [
          {
            id: "thread-parent",
            title: "Investigate the regression",
            titleSource: "explicit",
            linkedDirectories: [],
            source: "codex",
            updatedAt: 1_800_000_000_000,
            model: "gpt-5.6-sol",
          },
        ],
        nativeSubAgentThreads: [
          {
            id: nativeThreadId,
            title: "Audit settings discovery calls",
            titleSource: "explicit",
            linkedDirectories: [],
            source: "codex",
            createdAt: 1_799_999_900_000,
            updatedAt: 1_800_000_000_000,
            threadStatus: "idle",
            codexNativeSubAgent: {
              parentThreadId: "thread-parent",
              agentNickname: "Epicurus",
            },
          },
        ],
      }),
      overlayStore: store as never,
    });

    try {
      const { writes } = await measureSqliteWrites(async () => {
        await registry.listThreads({ backend: "codex" });
      });
      expectSqliteWriteBudget({
        // The repair happens once per native child: one parent pricing row and
        // one parent overlay card. At 100 repaired children/day, the measured
        // WAL projects to only a few MB/day and later snapshots write nothing.
        note:
          "one missing native child pricing row and parent sub-agent card discovered from the thread list",
        scenario: "native-subagent-discovery-backfill",
        writes,
      });

      const repeated = await measureSqliteWrites(async () => {
        await registry.listThreads({
          backend: "codex",
          forceRefresh: true,
        });
      });
      expect(repeated.writes.commits).toBe(0);
    } finally {
      await registry.close();
    }
  });

  it("repairs missing native sub-agent pricing in one boundary write", async () => {
    const nativeThreadId = "thread-epicurus-partial";
    await store.upsertThreadSubAgent({
      backend: "codex",
      threadId: "thread-parent-partial",
      subAgent: {
        monitorId: `codex-native:${nativeThreadId}`,
        task: "Audit partial pricing persistence",
        status: "success",
        createdAt: 1_799_999_900_000,
        updatedAt: 1_800_000_000_000,
        backend: "codex",
        monitorThreadId: nativeThreadId,
        monitorTurnId: "turn-epicurus-partial",
        agentName: "Epicurus",
        preferredModel: "gpt-5.6-sol",
        preferredReasoningEffort: "high",
        preferredFastMode: false,
        outcome: "success",
        completedAt: 1_800_000_000_000,
        monitorUsage: {
          model: "gpt-5.6-sol",
          fastMode: false,
          summary:
            "106,640 uncached in · 2,811,136 cached · 11,224 out (4,269 reasoning)",
          tokenUsage: {
            cachedInputTokens: 2_811_136,
            inputTokens: 2_917_776,
            outputTokens: 11_224,
            reasoningOutputTokens: 4_269,
            totalTokens: 2_933_269,
            uncachedInputTokens: 106_640,
          },
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient({
        threads: [
          {
            id: "thread-parent-partial",
            title: "Investigate the partial write",
            titleSource: "explicit",
            linkedDirectories: [],
            source: "codex",
            updatedAt: 1_800_000_000_000,
          },
        ],
        nativeSubAgentThreads: [
          {
            id: nativeThreadId,
            title: "Audit partial pricing persistence",
            titleSource: "explicit",
            linkedDirectories: [],
            source: "codex",
            createdAt: 1_799_999_900_000,
            updatedAt: 1_800_000_000_000,
            threadStatus: "idle",
            codexNativeSubAgent: {
              parentThreadId: "thread-parent-partial",
              agentNickname: "Epicurus",
            },
          },
        ],
      }),
      overlayStore: store as never,
    });

    try {
      const { writes } = await measureSqliteWrites(async () => {
        await registry.listThreads({ backend: "codex" });
      });
      expectSqliteWriteBudget({
        note:
          "one missing native child pricing row repaired from its existing parent sub-agent card",
        scenario: "native-subagent-pricing-repair",
        writes,
      });

      const repeated = await measureSqliteWrites(async () => {
        await registry.listThreads({
          backend: "codex",
          forceRefresh: true,
        });
      });
      expect(repeated.writes.commits).toBe(0);
    } finally {
      await registry.close();
    }
  });

  it("holds five deferred checks and their first alert to one commit", async () => {
    vi.useFakeTimers();
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
      resolveToolOutputAlertPolicy: () => ALERTING_TOOL_OUTPUT_POLICY,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    try {
      const { writes } = await measureSqliteWrites(async () => {
        for (let index = 0; index < 5; index += 1) {
          vi.setSystemTime(1_800_000_000_000 + index * 30_000);
          await emit({
            backend: "codex",
            notification: {
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  id: `wait-${index + 1}`,
                  type: "functionCall",
                  name: "wait",
                  status: "completed",
                  arguments: {
                    cell_id: `cell-${index + 1}`,
                    yield_time_ms: 30_000,
                  },
                  functionCallOutput: "still running",
                },
              },
            },
          } as AgentEvent);
        }
      });

      expectSqliteWriteBudget({
        note: "five in-memory 30-second deferred checks and one persisted alert boundary",
        scenario: "deferred-check-alert",
        writes,
      });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("holds one capped structured MCP result and its alert to one commit", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
      resolveToolOutputAlertPolicy: () => ALERTING_TOOL_OUTPUT_POLICY,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    const { writes } = await measureSqliteWrites(async () => {
      await emit({
        backend: "codex",
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
              result: {
                content: [{ type: "text", text: "x".repeat(40_100) }],
              },
            },
          },
        },
      } as AgentEvent);
    });

    expectSqliteWriteBudget({
      note: "one capped structured MCP result and its alert in one boundary",
      scenario: "structured-mcp-output-alert",
      writes,
    });

    await registry.close();
  });

  it("holds a burst of live token usage to one commit", async () => {
    vi.useFakeTimers();
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    try {
      const { writes } = await measureSqliteWrites(async () => {
        // Fifty cumulative snapshots for each of ten concurrently active
        // turns. Only the last snapshot per usageLineId belongs in sqlite.
        for (let index = 0; index < 500; index += 1) {
          const turnIndex = index % 10;
          const observation = Math.floor(index / 10) + 1;
          const inputTokens = observation * 1_000 + turnIndex;
          await emit(buildLiveUsageEvent({
            inputTokens,
            threadId: `thread-${turnIndex}`,
            turnId: `turn-${turnIndex}`,
          }));
        }

        // A terminal notification is an explicit durability boundary. It
        // drains every pending turn, not only the terminal event's own turn.
        await emit(buildTurnCompletedEvent("thread-0", "turn-0"));
      });

      expectSqliteWriteBudget({
        note:
          "500 cumulative usage observations across 10 turns, then one terminal flush",
        scenario: "live-thread-token-usage",
        writes,
      });

      for (let turnIndex = 0; turnIndex < 10; turnIndex += 1) {
        const pricing = await store.readThreadPricing({
          backend: "codex",
          threadId: `thread-${turnIndex}`,
        });
        expect(pricing.lines).toHaveLength(1);
        expect(pricing.lines[0]).toMatchObject({
          inputTokens: 50_000 + turnIndex,
          threadId: `thread-${turnIndex}`,
          turnId: `turn-${turnIndex}`,
        });
      }
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("bounds one ACP monitor lifecycle independently of heartbeat count", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const monitorRecord: {
      activeCommandCount: number;
      backend: "acp:kimi";
      createdAt: number;
      heartbeatIntervalSeconds: number;
      lastActivityAt: number;
      latestUsage?: TaskMonitorUsageSnapshot;
      monitorId: string;
      monitorThreadId: string;
      monitorTurnId: string;
      parentBackend: "acp:kimi";
      parentThreadId: string;
      persistedStatus?: string;
      pollIntervalSeconds: number;
      preferredModel: string;
      preferredReasoningEffort: string;
      startupTimeoutSeconds: number;
      task: string;
    } = {
      activeCommandCount: 0,
      backend: "acp:kimi",
      createdAt: 1_800_000_000_000,
      heartbeatIntervalSeconds: 30,
      lastActivityAt: 1_800_000_000_000,
      monitorId: "monitor-write-budget",
      monitorThreadId: "monitor-thread",
      monitorTurnId: "monitor-turn",
      parentBackend: "acp:kimi",
      parentThreadId: "parent-thread",
      pollIntervalSeconds: 30,
      preferredModel: "kimi-lite",
      preferredReasoningEffort: "low",
      startupTimeoutSeconds: 45,
      task: "Wait for one bounded external operation.",
    };
    const internal = registry as unknown as {
      completedTaskMonitorsByThread: Map<string, typeof monitorRecord>;
      injectTaskMonitorProgress(
        caller: {
          backend: "acp:kimi";
          threadId: string;
          turnId: string;
        },
        args: {
          monitorId: string;
          message: string;
          status: "running";
        },
      ): Promise<unknown>;
      persistTaskMonitorSubAgent(
        record: typeof monitorRecord,
        patch: Record<string, unknown>,
      ): Promise<void>;
      taskMonitorDelegations: Map<string, typeof monitorRecord>;
    };
    internal.taskMonitorDelegations.set(monitorRecord.monitorId, monitorRecord);

    try {
      const { writes } = await measureSqliteWrites(async () => {
        await internal.persistTaskMonitorSubAgent(monitorRecord, {
          status: "running",
        });
        // Four polls per minute for 30 minutes used to mean 120 sqlite
        // commits. Routine same-status heartbeats now stay transient.
        for (let index = 0; index < 120; index += 1) {
          await internal.injectTaskMonitorProgress(
            {
              backend: "acp:kimi",
              threadId: monitorRecord.monitorThreadId,
              turnId: monitorRecord.monitorTurnId,
            },
            {
              monitorId: monitorRecord.monitorId,
              message: `Still waiting (${index + 1}).`,
              status: "running",
            },
          );
        }
        await internal.persistTaskMonitorSubAgent(monitorRecord, {
          completedAt: 1_800_001_800_000,
          lastMessage: "External operation completed.",
          outcome: "success",
          status: "success",
        });
        internal.taskMonitorDelegations.delete(monitorRecord.monitorId);
        internal.completedTaskMonitorsByThread.set(
          "acp:kimi:monitor-thread",
          monitorRecord,
        );
        await registry.publishLocalEvent({
          backend: "acp:kimi",
          notification: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: monitorRecord.monitorThreadId,
              turnId: monitorRecord.monitorTurnId,
              model: monitorRecord.preferredModel,
              tokenUsage: {
                last_token_usage: {
                  input_tokens: 650,
                  cached_input_tokens: 150,
                  output_tokens: 40,
                  reasoning_output_tokens: 8,
                },
              },
            },
          },
        });
        await registry.publishLocalEvent({
          backend: "acp:kimi",
          notification: {
            method: "turn/completed",
            params: {
              threadId: monitorRecord.monitorThreadId,
              turnId: monitorRecord.monitorTurnId,
              turn: {
                id: monitorRecord.monitorTurnId,
                status: "completed",
                completedAt: 1_800_001_800_000,
                output: [],
              },
            },
          },
        });
      });

      expectSqliteWriteBudget({
        // Measured at four commits per completed monitor, independent of the
        // 120 heartbeats. At 100 monitors/day that is 400 commits/day; this
        // calibration observed about 115 KB per lifecycle, or about 11 MB/day.
        note:
          "one ACP monitor start, 120 transient heartbeats, completion, and final usage attribution",
        scenario: "acp-task-monitor-lifecycle",
        writes,
      });
      expect(internal.completedTaskMonitorsByThread.size).toBe(0);
    } finally {
      await registry.close();
    }
  });

  it("repairs a thread pricing history in one transaction", async () => {
    for (let index = 0; index < 25; index += 1) {
      await store.upsertThreadUsageLine({
        line: buildUnpricedGrokUsageLine(index),
      });
    }
    stateDb.raw
      .prepare(
        `UPDATE thread_usage_lines
         SET model = 'grok-4.6-build'
         WHERE thread_id = 'thread-pricing-repair'`,
      )
      .run();
    resetSqliteWriteMetrics();

    const { writes } = await measureSqliteWrites(async () => {
      const pricing = await store.readThreadPricing({
        backend: "acp:grok",
        threadId: "thread-pricing-repair",
      });
      expect(pricing.lines).toHaveLength(25);
      expect(
        pricing.lines.every((line) => line.priceStatus === "priced"),
      ).toBe(true);
      await store.readThreadPricing({
        backend: "acp:grok",
        threadId: "thread-pricing-repair",
      });
    });

    expectSqliteWriteBudget({
      note:
        "one thread load lazily reprices 25 usage rows in ten-row progress batches; a second load is read-only",
      scenario: "thread-pricing-lazy-repair",
      writes,
    });
  });

  it("persists one total-spend alert boundary without repeat writes", async () => {
    const { writes } = await measureSqliteWrites(async () => {
      await store.markThreadSpendAlerted({
        alertedAt: 1_800_000_000_000,
        backend: "codex",
        threadId: "thread-spend-alert",
      });
      await store.markThreadSpendAlerted({
        alertedAt: 1_800_000_000_001,
        backend: "codex",
        threadId: "thread-spend-alert",
      });
    });

    expect(
      (await store.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-spend-alert",
      }))?.threadSpendAlertedAt,
    ).toBe(1_800_000_000_000);
    expectSqliteWriteBudget({
      // The measured boundary is about 16 KB of WAL. Even 100 newly expensive
      // threads per day project to roughly 1.6 MB/day, with no repeat writes.
      note:
        "one total-spend alert boundary for a thread; later pricing updates are read-only",
      scenario: "thread-spend-alert-boundary",
      writes,
    });
  });

  it("holds a burst of automation pricing snapshots to one run-usage write", async () => {
    vi.useFakeTimers();
    const automationStore = new AutomationStore(stateDb);
    const registryListeners: Array<(event: AgentEvent) => void | Promise<void>> = [];
    const registry = {
      canStartThreadTurnImmediately: () => true,
      getThreadAgentMetadata: async () => ({
        name: "Agent",
        instructionLineCount: 0,
        instructionsTooLong: false,
        updatedAt: 1,
      }),
      onEvent: (listener: (event: AgentEvent) => void | Promise<void>) => {
        registryListeners.push(listener);
        return () => {};
      },
      publishLocalEvent: async () => {},
      setAutomationInspectionHandler: () => {},
      startAutomationHeadlessTurn: async (params: {
        agentThreadId: string;
        automationRunId: string;
        backend: string;
      }) => ({
        backend: params.backend,
        headlessThreadId: "headless-1",
        queueEntryId: `headless:${params.automationRunId}`,
        threadId: params.agentThreadId,
        turnId: "turn-1",
      }),
    } as unknown as ConstructorParameters<
      typeof DesktopAutomationService
    >[0]["registry"];
    const service = new DesktopAutomationService({
      registry,
      store: automationStore,
    });
    try {
      service.start();
      const created = await service.create({
        backend: "codex",
        threadId: "thread-1",
        name: "Usage burst",
        taskPrompt: "Check.",
        schedule: { kind: "interval", every: 5, unit: "minutes" },
      });
      await service.runNow({ automationId: created.automation.id });

      const { writes } = await measureSqliteWrites(async () => {
        // Fifty cumulative pricing snapshots for one streaming turn. Each
        // setRunUsage rewrites the whole run payload row, so the debounce is
        // what keeps this at one commit instead of fifty.
        for (let observation = 1; observation <= 50; observation += 1) {
          await Promise.all(
            registryListeners.map((listener) =>
              listener({
                backend: "codex",
                notification: {
                  method: "thread/pricing/updated",
                  params: {
                    threadId: "thread-1",
                    pricing: {
                      summaries: [],
                      lines: [
                        {
                          scope: "turn",
                          turnId: "turn-1",
                          model: "gpt-5",
                          uncachedInputTokens: observation * 100,
                          outputTokens: observation * 10,
                          totalCostMicros: observation * 1_000,
                          currency: "USD",
                        },
                      ],
                    },
                  },
                },
                // Partial ThreadUsageLineRecord: only what the capture reads.
              } as unknown as AgentEvent),
            ),
          );
        }
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expectSqliteWriteBudget({
        note: "50 cumulative pricing snapshots for one run, one debounced payload write",
        scenario: "automation-run-usage",
        writes,
      });
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("holds a long automation transcript to one boundary artifact write", async () => {
    vi.useFakeTimers();
    const automationStore = new AutomationStore(stateDb);
    const registryListeners: Array<(event: AgentEvent) => void | Promise<void>> = [];
    const registry = {
      canStartThreadTurnImmediately: () => true,
      getThreadAgentMetadata: async () => ({
        name: "Agent",
        instructionLineCount: 0,
        instructionsTooLong: false,
        updatedAt: 1,
      }),
      onEvent: (listener: (event: AgentEvent) => void | Promise<void>) => {
        registryListeners.push(listener);
        return () => {};
      },
      publishLocalEvent: async () => {},
      setAutomationInspectionHandler: () => {},
      startAutomationHeadlessTurn: async (params: {
        agentThreadId: string;
        automationRunId: string;
        backend: string;
      }) => ({
        backend: params.backend,
        headlessThreadId: "headless-1",
        queueEntryId: `headless:${params.automationRunId}`,
        threadId: params.agentThreadId,
        turnId: "turn-1",
      }),
    } as unknown as ConstructorParameters<
      typeof DesktopAutomationService
    >[0]["registry"];
    const service = new DesktopAutomationService({
      registry,
      store: automationStore,
    });
    try {
      service.start();
      const created = await service.create({
        backend: "codex",
        threadId: "thread-1",
        name: "Transcript burst",
        taskPrompt: "Check.",
        schedule: { kind: "interval", every: 24, unit: "hours" },
      });
      const runNow = await service.runNow({ automationId: created.automation.id });

      const { writes } = await measureSqliteWrites(async () => {
        // Fifty five-minute windows with fifty items each model a long-running,
        // tool-heavy automation. Periodic whole-artifact rewrites would make
        // WAL growth quadratic as every window rewrote all prior windows.
        // One 2,500-item boundary write measures 704,520 WAL bytes; even ten
        // such extreme runs/day stay linear at 7,045,200 bytes (about 6.7 MiB).
        for (let windowIndex = 0; windowIndex < 50; windowIndex += 1) {
          for (let itemIndex = 0; itemIndex < 50; itemIndex += 1) {
            await Promise.all(
              registryListeners.map((listener) =>
                listener({
                  backend: "codex",
                  notification: {
                    method: "item/completed",
                    params: {
                      threadId: "headless-1",
                      turnId: "turn-1",
                      item: {
                        id: `tool-${windowIndex}-${itemIndex}`,
                        type: "mcpToolCall",
                        toolName: `tool-${windowIndex}-${itemIndex}`,
                      },
                    },
                  },
                } as unknown as AgentEvent),
              ),
            );
          }
          await vi.advanceTimersByTimeAsync(5 * 60_000);
          expect(automationStore.getRunArtifact(runNow.run.id)).toBeUndefined();
        }
        service.dispose();
      });

      expectSqliteWriteBudget({
        note: "2,500 completed tool items across 50 windows, one shutdown-boundary artifact write",
        scenario: "automation-run-transcript-burst",
        writes,
      });
      expect(
        automationStore.getRunArtifact(runNow.run.id)?.transcriptEvents,
      ).toHaveLength(2_500);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("budgets recurring live usage timer windows", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "clearTimeout", "setTimeout"],
    });
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    try {
      const { writes } = await measureSqliteWrites(async () => {
        // Ten consecutive one-second windows, each with a fresh cumulative
        // observation. Unlike the burst budget, this pins the recurring
        // commit cadence paid when observations do not share a window.
        for (let window = 1; window <= 10; window += 1) {
          await emit(buildLiveUsageEvent({
            inputTokens: window * 1_000,
            threadId: "timer-thread",
            turnId: "timer-turn",
          }));
          await vi.advanceTimersByTimeAsync(1_000);
        }
      });

      expect(batchWrite).toHaveBeenCalledTimes(10);
      expectSqliteWriteBudget({
        note:
          "10 cumulative live-usage observations separated by full one-second timer windows",
        scenario: "live-thread-token-usage-timer-windows",
        writes,
      });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("flushes pending live usage before replay hydration supersedes it", async () => {
    vi.useFakeTimers();
    const threadId = "thread-hydration-race";
    const turnId = "turn-hydration-race";
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient({
        replay: buildHydratedUsageReplay({ threadId, turnId }),
      }),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    try {
      await emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId,
        turnId,
      }));
      expect(batchWrite).not.toHaveBeenCalled();

      await registry.readThread({ backend: "codex", threadId });
      await vi.advanceTimersByTimeAsync(1_000);

      const pricing = await store.readThreadPricing({
        backend: "codex",
        threadId,
      });
      expect(pricing.lines).toHaveLength(1);
      expect(pricing.lines[0]).toMatchObject({
        source: "hydration",
        status: "finalized",
        turnId,
        usageLineId: `codex:${threadId}:${turnId}:hydration`,
      });
      expect(pricing.summaries[0]?.usageLineCount).toBe(1);
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("waits for earlier live usage before crossing a terminal durability boundary", async () => {
    const overlayLookupStarted = createDeferred();
    const releaseOverlayLookup = createDeferred();
    const readOverlay = store.getThreadOverlayState.bind(store);
    vi.spyOn(store, "getThreadOverlayState").mockImplementationOnce(
      async (params) => {
        overlayLookupStarted.resolve();
        await releaseOverlayLookup.promise;
        return await readOverlay(params);
      },
    );
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);
    let usageEmit = Promise.resolve();
    let terminalEmit = Promise.resolve();
    let terminalDelivered = false;
    registry.onEvent((event) => {
      if (event.notification.method === "turn/completed") {
        terminalDelivered = true;
      }
    });

    try {
      usageEmit = emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId: "thread-terminal-race",
        turnId: "turn-terminal-race",
      }));
      await overlayLookupStarted.promise;

      terminalEmit = emit(
        buildTurnCompletedEvent("thread-terminal-race", "turn-terminal-race"),
      );
      await waitForAsyncWork();

      expect(terminalDelivered).toBe(false);
      expect(batchWrite).not.toHaveBeenCalled();

      releaseOverlayLookup.resolve();
      await Promise.all([usageEmit, terminalEmit]);

      expect(batchWrite).toHaveBeenCalledTimes(1);
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-terminal-race",
        })).lines[0],
      ).toMatchObject({ inputTokens: 1_000 });
    } finally {
      releaseOverlayLookup.resolve();
      await Promise.allSettled([usageEmit, terminalEmit]);
      await registry.close();
    }
  });

  it("persists pre-close live usage after a delayed lookup and ignores new usage", async () => {
    const overlayLookupStarted = createDeferred();
    const releaseOverlayLookup = createDeferred();
    const readOverlay = store.getThreadOverlayState.bind(store);
    const overlayLookup = vi
      .spyOn(store, "getThreadOverlayState")
      .mockImplementationOnce(async (params) => {
        overlayLookupStarted.resolve();
        await releaseOverlayLookup.promise;
        return await readOverlay(params);
      });
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);
    let usageEmit = Promise.resolve();
    let postCloseEmit = Promise.resolve();
    let closePromise: Promise<void> | undefined;
    let closeSettled = false;

    try {
      usageEmit = emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId: "thread-close-race",
        turnId: "turn-close-race",
      }));
      await overlayLookupStarted.promise;

      closePromise = registry.close().finally(() => {
        closeSettled = true;
      });
      postCloseEmit = emit(buildLiveUsageEvent({
        inputTokens: 2_000,
        threadId: "thread-close-race",
        turnId: "turn-close-race",
      }));
      await postCloseEmit;
      await waitForAsyncWork();

      expect(closeSettled).toBe(false);
      expect(overlayLookup).toHaveBeenCalledTimes(1);
      expect(batchWrite).not.toHaveBeenCalled();

      releaseOverlayLookup.resolve();
      await Promise.all([usageEmit, closePromise]);

      expect(batchWrite).toHaveBeenCalledTimes(1);
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-close-race",
        })).lines[0],
      ).toMatchObject({ inputTokens: 1_000 });
    } finally {
      releaseOverlayLookup.resolve();
      closePromise ??= registry.close();
      await Promise.allSettled([usageEmit, postCloseEmit, closePromise]);
    }
  });

  it("releases the terminal barrier when earlier live usage derivation fails", async () => {
    vi.spyOn(store, "getThreadOverlayState").mockRejectedValueOnce(
      new Error("overlay unavailable"),
    );
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    try {
      const usageEmit = emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId: "thread-usage-error",
        turnId: "turn-usage-error",
      }));
      const usageRejected = expect(usageEmit).rejects.toThrow(
        "overlay unavailable",
      );
      const terminalEmit = emit(
        buildTurnCompletedEvent("thread-usage-error", "turn-usage-error"),
      );

      await Promise.all([
        usageRejected,
        expect(terminalEmit).resolves.toBeUndefined(),
      ]);
      expect(batchWrite).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  });

  it("flushes coalesced live usage on the bounded timer", async () => {
    vi.useFakeTimers();
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);
    const pricingEvents: AgentEvent[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "thread/pricing/updated") {
        pricingEvents.push(event);
      }
    });

    try {
      await emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId: "thread-timer",
        turnId: "turn-timer",
      }));
      await emit(buildLiveUsageEvent({
        inputTokens: 2_000,
        threadId: "thread-timer",
        turnId: "turn-timer",
      }));

      expect(batchWrite).not.toHaveBeenCalled();
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-timer",
        })).lines,
      ).toEqual([]);

      await vi.advanceTimersByTimeAsync(999);
      expect(batchWrite).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(batchWrite).toHaveBeenCalledTimes(1);
      expect(batchWrite.mock.calls[0]?.[0].lines).toHaveLength(1);
      expect(batchWrite.mock.calls[0]?.[0].lines[0]).toMatchObject({
        inputTokens: 2_000,
        usageLineId: "codex:thread-timer:turn-timer:live-token-usage",
      });
      expect(pricingEvents).toHaveLength(1);
      expect(pricingEvents[0]?.notification).toMatchObject({
        method: "thread/pricing/updated",
        params: {
          pricing: {
            lines: [expect.objectContaining({ inputTokens: 2_000 })],
          },
          threadId: "thread-timer",
        },
      });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("retries a failed batch without overwriting a newer observation", async () => {
    vi.useFakeTimers();
    const firstWriteStarted = createDeferred();
    const releaseFirstWrite = createDeferred();
    const originalBatchWrite = store.upsertThreadUsageLines.bind(store);
    const batchWrite = vi
      .spyOn(store, "upsertThreadUsageLines")
      .mockImplementationOnce(async () => {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
        throw new Error("disk busy");
      })
      .mockImplementation(async (params) => await originalBatchWrite(params));
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);
    const flush = (registry as unknown as {
      flushLiveThreadUsageLines(): Promise<void>;
    }).flushLiveThreadUsageLines.bind(registry);

    try {
      await emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId: "thread-retry",
        turnId: "turn-retry",
      }));
      const firstFlush = flush();
      await firstWriteStarted.promise;

      // This newer cumulative snapshot arrives while the older batch is in
      // flight. Requeueing the failed batch must not put 1,000 back on top.
      await emit(buildLiveUsageEvent({
        inputTokens: 2_000,
        threadId: "thread-retry",
        turnId: "turn-retry",
      }));
      releaseFirstWrite.resolve();
      await firstFlush;
      await flush();

      expect(batchWrite).toHaveBeenCalledTimes(2);
      expect(batchWrite.mock.calls[1]?.[0].lines).toHaveLength(1);
      expect(batchWrite.mock.calls[1]?.[0].lines[0]).toMatchObject({
        inputTokens: 2_000,
      });
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-retry",
        })).lines[0],
      ).toMatchObject({ inputTokens: 2_000 });
    } finally {
      releaseFirstWrite.resolve();
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("flushes live usage on close and ignores post-close writes", async () => {
    vi.useFakeTimers();
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);
    let closed = false;

    try {
      await emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId: "thread-close",
        turnId: "turn-close",
      }));
      expect(batchWrite).not.toHaveBeenCalled();

      await registry.close();
      closed = true;
      expect(batchWrite).toHaveBeenCalledTimes(1);
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-close",
        })).lines[0],
      ).toMatchObject({ inputTokens: 1_000 });

      await emit(buildLiveUsageEvent({
        inputTokens: 2_000,
        threadId: "thread-close",
        turnId: "turn-close",
      }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(batchWrite).toHaveBeenCalledTimes(1);
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-close",
        })).lines[0],
      ).toMatchObject({ inputTokens: 1_000 });
    } finally {
      if (!closed) {
        await registry.close();
      }
      vi.useRealTimers();
    }
  });

  it("holds messaging and federation for an idle hour without sqlite writes", async () => {
    const instances = new AppRuntimeInstanceStore(stateDb);
    const leases = new RuntimeLeaseManager({
      cwd: "/tmp/PwrAgnt",
      instanceId: "instance-1",
      now: () => 1_800_000_000_000,
      profileName: "default",
      processId: 1234,
      processIsAlive: () => true,
      store: instances,
    });
    leases.acquire("messaging");
    leases.acquire("federation");

    const { writes } = await measureSqliteWrites(() => {
      for (let tick = 0; tick < 360; tick += 1) {
        leases.snapshot("messaging");
        leases.snapshot("federation");
      }
    });

    expectSqliteWriteBudget({
      note: "one idle hour: PID-owned messaging and federation leases",
      scenario: "idle-hour-runtime-leases",
      writes,
    });
  });

  it("holds a federated child mount to its write budget", async () => {
    const { writes } = await measureSqliteWrites(async () => {
      await store.addRemoteThreadPin({
        ref: buildFederatedThreadRef({
          backend: "codex",
          instanceId: "pwr_child",
          threadId: "thread-child",
        }),
        instanceLabel: "Child Mac",
        pinnedVia: "child",
        summary: {
          source: "codex",
          id: "thread-child",
          title: "Remote child",
          titleSource: "fallback",
          linkedDirectories: [],
          inbox: { inInbox: false },
          parentThreadId: "thread-parent",
          parentThreadBackend: "codex",
          parentThreadInstanceId: "pwr_parent",
        },
      });
    });

    expectSqliteWriteBudget({
      note: "persist one cross-instance child mount and its routing target",
      scenario: "federated-child-mount",
      writes,
    });
  });

  it("holds federated child archive-ungrouping to its write budget", async () => {
    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "pwr_child",
      threadId: "thread-child",
    });
    const linkedSummary = {
      source: "codex" as const,
      id: "thread-child",
      title: "Remote child",
      titleSource: "fallback" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex" as const,
      parentThreadInstanceId: "pwr_parent",
    };
    await store.addRemoteThreadPin({
      ref,
      instanceLabel: "Child Mac",
      pinnedVia: "child",
      summary: linkedSummary,
    });
    await store.setThreadParent({
      backend: "codex",
      threadId: "thread-child",
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex",
      parentThreadInstanceId: "pwr_parent",
    });

    const { writes } = await measureSqliteWrites(async () => {
      await store.setThreadParent({
        backend: "codex",
        threadId: "thread-child",
        parentThreadId: undefined,
      });
      await store.updateRemoteThreadPinSnapshots([{
        ref,
        instanceLabel: "Child Mac",
        summary: {
          ...linkedSummary,
          parentThreadId: undefined,
          parentThreadBackend: undefined,
          parentThreadInstanceId: undefined,
        },
      }]);
    });

    expectSqliteWriteBudget({
      note: "clear one child-owner parent overlay and refresh its root-owner pin",
      scenario: "federated-child-archive-ungroup",
      writes,
    });
  });

  it("holds runtime lease acquisition and release to its budget", async () => {
    const leases = new RuntimeLeaseManager({
      cwd: "/tmp/PwrAgnt",
      instanceId: "instance-1",
      now: () => 1_800_000_000_000,
      processId: 1234,
      processIsAlive: () => true,
      profileName: "default",
      store: new AppRuntimeInstanceStore(stateDb),
    });

    const { writes } = await measureSqliteWrites(() => {
      leases.acquire("messaging");
      leases.acquire("federation");
      leases.release("federation");
      leases.release("messaging");
      leases.markExited();
    });

    expectSqliteWriteBudget({
      note: "register once, acquire and release both runtime leases, mark exited",
      scenario: "runtime-lease-lifecycle",
      writes,
    });
  });

  it("holds dead-process takeover of both runtime leases to its budget", async () => {
    let now = 1_800_000_001_000;
    const instances = new AppRuntimeInstanceStore(stateDb);
    const owner = new RuntimeLeaseManager({
      cwd: "/tmp/PwrAgnt-a",
      instanceId: "instance-a",
      now: () => 1_800_000_000_000,
      processId: 1234,
      processIsAlive: () => true,
      profileName: "default",
      store: instances,
    });
    owner.acquire("messaging");
    owner.acquire("federation");
    const challenger = new RuntimeLeaseManager({
      cwd: "/tmp/PwrAgnt-b",
      instanceId: "instance-b",
      now: () => now,
      processId: 5678,
      processIsAlive: () => false,
      profileName: "default",
      store: instances,
    });

    const { writes } = await measureSqliteWrites(() => {
      challenger.acquire("messaging");
      challenger.acquire("federation");
      now += RUNTIME_LEASE_DEAD_OWNER_GRACE_MS;
      challenger.acquire("messaging");
      challenger.acquire("federation");
    });

    expectSqliteWriteBudget({
      note: "observe one dead owner, wait one minute, replace both runtime leases",
      scenario: "runtime-lease-dead-owner-takeover",
      writes,
    });
  });
});

function buildLiveUsageEvent(params: {
  inputTokens: number;
  threadId: string;
  turnId: string;
}): AgentEvent {
  const cachedInputTokens = Math.max(0, params.inputTokens - 100);
  return {
    backend: "codex",
    notification: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: params.threadId,
        turnId: params.turnId,
        model: "gpt-5.5",
        tokenUsage: {
          total: {
            inputTokens: params.inputTokens,
            cachedInputTokens,
            outputTokens: 100,
          },
          last: {
            inputTokens: params.inputTokens,
            cachedInputTokens,
            outputTokens: 100,
          },
        },
      },
    },
  } as AgentEvent;
}

function buildTurnCompletedEvent(threadId: string, turnId: string): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "turn/completed",
      params: {
        threadId,
        turnId,
        turn: {
          id: turnId,
          status: "completed",
          output: [],
        },
      },
    },
  } as AgentEvent;
}

function buildHydratedUsageReplay(params: {
  threadId: string;
  turnId: string;
}): AppServerThreadReplay {
  const usageLine: ThreadUsageLineRecord = {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 1_200,
    completedAt: 2_000,
    createdAt: 2_000,
    currency: "USD",
    inputTokens: 1_500,
    model: "gpt-5.5",
    outputCostMicros: 0,
    outputTokens: 150,
    priceStatus: "unpriced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "turn",
    source: "hydration",
    sourceItemId: "hydrated-usage",
    status: "finalized",
    threadId: params.threadId,
    totalCostMicros: 0,
    totalTokens: 1_650,
    turnId: params.turnId,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 300,
    usageLineId: `codex:${params.threadId}:${params.turnId}:hydration`,
  };
  return {
    entries: [
      {
        type: "activity",
        id: "hydrated-usage",
        summary: "Turn usage: hydrated",
        status: "completed",
        createdAt: 2_000,
        details: [],
        turn: {
          id: params.turnId,
          status: "completed",
        },
        usageLine,
      },
    ],
    messages: [],
    pagination: {
      hasPreviousPage: false,
      supportsPagination: false,
    },
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitForAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function buildInvocation(invocationId: string) {
  return {
    backend: "codex" as const,
    category: "shell" as const,
    debugLines: 0,
    errorLines: 0,
    estimatedOutputTokens: 25,
    infoLines: 0,
    invocationId,
    itemId: invocationId,
    noisy: false,
    observedAt: 1_800_000_000_000,
    outputChars: 100,
    outputLines: 4,
    outputTruncated: false,
    status: "completed" as const,
    threadId: "thread-1",
    toolName: "commandExecution",
    updatedAt: 1_800_000_000_000,
    warningLines: 0,
  };
}

function buildUnpricedGrokUsageLine(index: number): ThreadUsageLineRecord {
  const createdAt = Date.UTC(2026, 7, 15) + index;
  return {
    backend: "acp:grok",
    cachedInputCostMicros: 0,
    cachedInputTokens: 315_776,
    createdAt,
    currency: "USD",
    inputTokens: 316_222,
    model: "unknown-grok-model",
    outputCostMicros: 0,
    outputTokens: 121,
    priceStatus: "unpriced",
    priceUnavailableReason: "missing-rate",
    provider: "openai",
    reasoningEffort: "high",
    reasoningOutputTokens: 50,
    scope: "turn",
    settingsConfidence: "exact",
    settingsSource: "turn-context",
    source: "hydration",
    sourceItemId: `item-pricing-repair-${index}`,
    status: "finalized",
    threadId: "thread-pricing-repair",
    totalCostMicros: 0,
    totalTokens: 316_343,
    turnId: `turn-pricing-repair-${index}`,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 446,
    usageLineId: `line-pricing-repair-${index}`,
  };
}

  it("keeps a typed message to one journal row, at one commit per debounced save", async () => {
    // ROWS is what this pins, and it is deliberately measured under a save
    // per keystroke — a stress case for the collapse rule, not a claim about
    // how often the app saves. `shouldReplacePreviousUnsentDraft` compares
    // `trimEnd`ed texts, so a strict "next must be longer" check failed on
    // every typed space and inserted a fresh row: one journal row per WORD,
    // fifteen near-identical rows for one sentence. It must stay at one
    // however many saves arrive.
    //
    // COMMITS here is the per-save cost at the STORE — one save call, one
    // transaction — and 70 of them because this test makes 70 calls. Do not
    // read it as the cost of typing a sentence: the renderer coalesces edits
    // into at most one save per `DURABLE_SAVE_INTERVAL_MS` (5s) and skips
    // unchanged content entirely, so real typing reaches this store roughly
    // once every five seconds, not once per character.
    const drafts = new ComposerDraftRecoveryStore(stateDb);
    const sentence =
      "I like dogs and cats and bears, and I have opinions about all of them.";

    // Seeding is nothing here — the typing IS the measured work.
    const { writes } = await measureSqliteWrites(async () => {
      for (let index = 1; index <= sentence.length; index += 1) {
        const text = sentence.slice(0, index);
        drafts.save({
          draft: {
            scopeKey: "thread:codex:typing",
            scopeKind: "thread",
            backend: "codex",
            threadId: "typing",
            text,
            skillTokens: [],
            imageAttachments: [],
            status: "unsent",
            createdAt: 1,
            updatedAt: 1_786_500_000_000 + index,
            contentHash: `hash-${text}`,
            charCount: text.length,
          },
          recordHistory: true,
        });
      }
    });

    const journalRows = (
      stateDb.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM composer_draft_journal WHERE scope_key = ?",
        )
        .get("thread:codex:typing") as { n: number }
    ).n;
    expect(journalRows).toBe(1);

    expectSqliteWriteBudget({
      note:
        "70 direct store saves (a stress case for prefix collapse, NOT the "
        + "app's typing cadence — the renderer coalesces to one save per 5s): "
        + "exactly one journal row survives, and commits track save calls "
        + "because each save is its own transaction",
      scenario: "composer-draft-typing",
      writes,
    });
  });

  it("keeps the hourly GC pass at one commit while sweeping stale drafts", async () => {
    // Added for the composer-draft staleness sweep, but it measures the WHOLE
    // `cleanupExpired` call, because that is the unit that costs a commit.
    // The number to defend is `commits: 1` — every sweep in there rides one
    // transaction, and a new sweep that opens its own would show up here as a
    // second commit. Statements and rows legitimately move when someone adds
    // a sweep; re-record then, and do not read such a change as a composer
    // regression.
    const NOW = 1_786_500_000_000;
    const DAY = 24 * 60 * 60 * 1000;
    const drafts = new ComposerDraftRecoveryStore(stateDb);
    for (let index = 0; index < 40; index += 1) {
      drafts.save({
        draft: {
          scopeKey: `thread:codex:thread-${index}`,
          scopeKind: "thread",
          backend: "codex",
          threadId: `thread-${index}`,
          text: `draft ${index}`,
          skillTokens: [],
          imageAttachments: [],
          status: "unsent",
          createdAt: 1,
          // Half are stale enough to sweep, half are current.
          updatedAt: index < 20 ? NOW - 200 * DAY : NOW - DAY,
          contentHash: `hash-${index}`,
          charCount: 7,
        },
      });
    }

    // Also give the journal prefix-collapse real work, so this budget covers
    // every sweep in the transaction rather than only the one it was written
    // for. These rows have to be inserted RAW: `save()` applies the collapse
    // at write time, so seeding through it would leave an already-collapsed
    // journal and the GC pass would measure nothing.
    const insertJournalRow = stateDb.raw.prepare(
      `INSERT INTO composer_draft_journal(
         scope_key, scope_kind, status, content_hash, char_count,
         created_at, updated_at, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const sentence = "I like dogs and cats and bears";
    for (let index = 1; index <= sentence.length; index += 1) {
      const text = sentence.slice(0, index);
      insertJournalRow.run(
        "thread:codex:journal",
        "thread",
        "unsent",
        `journal-hash-${text}`,
        text.length,
        1,
        NOW - DAY + index,
        JSON.stringify({ text }),
      );
    }

    // Seeding is outside the measured region, so the budget tracks the sweeps.
    const { writes } = await measureSqliteWrites(async () => {
      stateDb.cleanupExpired(NOW);
    });

    // The collapse ran inside the measured pass: one row survives the chain.
    expect(
      (
        stateDb.raw
          .prepare(
            "SELECT COUNT(*) AS n FROM composer_draft_journal WHERE scope_key = ?",
          )
          .get("thread:codex:journal") as { n: number }
      ).n,
    ).toBe(1);

    expectSqliteWriteBudget({
      note:
        "one whole cleanupExpired GC pass doing real work in both composer "
        + "sweeps: ageing out 20 drafts past 180 days AND collapsing a 30-row "
        + "journal prefix chain to 1. commits is the assertion that matters "
        + "(every sweep rides one transaction); statements/rows legitimately "
        + "move when a sweep is added, so re-record rather than reading it as "
        + "a composer regression",
      scenario: "cleanup-expired-gc-pass",
      writes,
    });
  });

function createStubBackendClient(options?: {
  nativeSubAgentThreads?: AppServerThreadSummary[];
  replay?: AppServerThreadReplay;
  threads?: AppServerThreadSummary[];
}) {
  return {
    close: async () => {},
    getInitializeResult: async () => ({
      methods: [
        ...(options?.replay ? ["thread/read"] : []),
        ...(options?.threads ? ["thread/list"] : []),
      ],
    }),
    listNativeSubAgentThreads: async () => options?.nativeSubAgentThreads ?? [],
    listThreads: async () => options?.threads ?? [],
    onNotification: () => () => {},
    onPendingRequest: () => () => {},
    readThread: async () =>
      options?.replay ?? {
        entries: [],
        messages: [],
        pagination: {
          hasPreviousPage: false,
          supportsPagination: false,
        },
      },
  } as never;
}
