import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ThreadToolInvocationAlert,
  ThreadToolInvocationRecord,
} from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-tool-accounting-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteOverlayStore tool invocation accounting", () => {
  it("round-trips invocation metrics, summaries, recent reads, and alerts", async () => {
    await store.upsertThreadToolInvocation({
      invocation: buildInvocation({
        invocationId: "tool-1",
        outputChars: 12_000,
        warningLines: 4,
      }),
    });
    await store.upsertThreadToolInvocation({
      invocation: buildInvocation({
        invocationId: "tool-2",
        itemId: "tool-2",
        outputChars: 8_000,
        observedAt: 1_800_000_030_000,
        warningLines: 2,
      }),
    });
    await store.markThreadToolInvocationNoisy({
      invocationId: "tool-2",
      reason: "repeat-polling-output",
    });
    await store.upsertThreadToolInvocationAlert({
      alert: buildAlert(),
    });

    const accounting = await store.readThreadToolAccounting({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(accounting.invocations).toHaveLength(2);
    expect(accounting.invocations[0]).toMatchObject({
      invocationId: "tool-2",
      noisy: true,
      noisyReason: "repeat-polling-output",
      outputChars: 8_000,
    });
    expect(accounting.summaries).toEqual([
      expect.objectContaining({
        category: "polling",
        estimatedOutputTokens: 5_000,
        invocationCount: 2,
        noisyInvocationCount: 1,
        outputChars: 20_000,
        toolName: "write_stdin",
        warningLines: 6,
      }),
    ]);
    expect(accounting.alerts).toEqual([
      expect.objectContaining({
        alertId: "alert-1",
        invocationCount: 2,
        totalOutputChars: 20_000,
      }),
    ]);

    const recent = store.readRecentThreadToolInvocations({
      backend: "codex",
      limit: 5,
      sessionId: "40500",
      since: 1_800_000_000_000,
      threadId: "thread-1",
      toolName: "write_stdin",
    });
    expect(recent.map((record) => record.invocationId)).toEqual([
      "tool-2",
      "tool-1",
    ]);
  });

  it("accumulates in-progress output deltas before terminal completion", async () => {
    await store.upsertThreadToolInvocation({
      invocation: buildInvocation({
        invocationId: "delta-tool",
        itemId: "delta-tool",
        outputChars: 100,
        outputLines: 4,
        status: "in_progress",
        warningLines: 1,
      }),
    });
    await store.upsertThreadToolInvocation({
      invocation: buildInvocation({
        invocationId: "delta-tool",
        itemId: "delta-tool",
        observedAt: 1_800_000_001_000,
        outputChars: 150,
        outputLines: 6,
        status: "in_progress",
        warningLines: 2,
      }),
    });
    await store.upsertThreadToolInvocation({
      invocation: buildInvocation({
        completedAt: 1_800_000_002_000,
        invocationId: "delta-tool",
        itemId: "delta-tool",
        observedAt: 1_800_000_002_000,
        outputChars: 200,
        outputLines: 8,
        status: "completed",
        warningLines: 2,
      }),
    });

    const accounting = await store.readThreadToolAccounting({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(accounting.invocations[0]).toMatchObject({
      completedAt: 1_800_000_002_000,
      estimatedOutputTokens: 63,
      outputChars: 250,
      outputLines: 10,
      status: "completed",
      warningLines: 3,
    });
  });
});

function buildInvocation(
  patch: Partial<ThreadToolInvocationRecord> = {},
): ThreadToolInvocationRecord {
  const outputChars = patch.outputChars ?? 12_000;
  const observedAt = patch.observedAt ?? 1_800_000_000_000;
  return {
    backend: "codex",
    category: "polling",
    debugLines: 0,
    errorLines: 0,
    estimatedOutputTokens: Math.ceil(outputChars / 4),
    infoLines: 0,
    invocationId: "tool-1",
    itemId: "tool-1",
    noisy: false,
    normalizedCommand: "poll session 40500",
    observedAt,
    outputChars,
    outputLines: 200,
    outputTruncated: false,
    sessionId: "40500",
    status: "completed",
    threadId: "thread-1",
    toolName: "write_stdin",
    turnId: "turn-1",
    updatedAt: observedAt,
    warningLines: 0,
    ...patch,
  };
}

function buildAlert(): ThreadToolInvocationAlert {
  return {
    alertId: "alert-1",
    averageIntervalMs: 30_000,
    backend: "codex",
    createdAt: 1_800_000_030_000,
    estimatedOutputTokens: 5_000,
    firstObservedAt: 1_800_000_000_000,
    invocationCount: 2,
    kind: "noisy-polling",
    lastObservedAt: 1_800_000_030_000,
    message: "Repeated write_stdin polling on session 40500 produced 20,000 chars.",
    sessionId: "40500",
    severity: "warning",
    suggestedPrompt: "Use create_monitor_delegation.",
    threadId: "thread-1",
    toolName: "write_stdin",
    totalOutputChars: 20_000,
    updatedAt: 1_800_000_030_000,
  };
}
