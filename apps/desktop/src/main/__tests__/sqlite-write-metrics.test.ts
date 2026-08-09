import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import {
  readSqliteWriteMetrics,
  resetSqliteWriteMetrics,
  SQLITE_WRITE_METRICS_ENV,
} from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

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
    //
    // This drives the real registry into a real store and asserts the shape of
    // the write pattern rather than a wall-clock number, so it means the same
    // thing on a loaded CI box as on a fast laptop.
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    const chunks = 500;
    for (let index = 0; index < chunks; index += 1) {
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

    const metrics = readSqliteWriteMetrics();
    // One flush carrying every buffered chunk, plus the completion row. The
    // point is that this does not scale with `chunks`.
    expect(metrics?.commits).toBeLessThanOrEqual(4);
    expect(metrics?.commits).toBeGreaterThan(0);

    await registry.close();
  });
});

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

function createStubBackendClient() {
  return {
    close: async () => {},
    getInitializeResult: async () => ({ methods: [] }),
    onNotification: () => () => {},
    onPendingRequest: () => () => {},
  } as never;
}
