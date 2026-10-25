import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  SandboxerPrCleanupService,
  formatSandboxCleanupLines,
  readCreatedSandbox,
  type SandboxerCleanupTransport,
} from "../mcp-connections/sandboxer-pr-cleanup";
import { ThreadSandboxStore } from "../state/thread-sandbox-store";
import { StateDb } from "../state/state-db";
import {
  measureSqliteWrites,
  SQLITE_WRITE_METRICS_ENV,
} from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const CONNECTION = "builtin:sandboxer";
let stateDb: StateDb;
let store: ThreadSandboxStore;
let tempDir: string;
let now: number;

beforeEach(() => {
  now = 1_000;
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("pwragent-sandboxer-cleanup-");
  tempDir = temp.tempDir;
  stateDb = StateDb.open(temp.dbPath);
  store = new ThreadSandboxStore(stateDb.raw);
});

afterEach(() => {
  vi.unstubAllEnvs();
  stateDb.close();
  removeTempStateDbDir(tempDir);
});

function created(sandboxId: string, threadId = "thread-1", name?: string): void {
  store.recordCreated({
    connectionId: CONNECTION,
    sandboxId,
    threadId,
    ...(name ? { name } : {}),
    now,
  });
}

function ok(text = "{}"): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function transport(
  tools: string[],
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult> = async () => ok(),
) {
  const callTool = vi.fn(call);
  const close = vi.fn();
  const value: SandboxerCleanupTransport = {
    listToolNames: vi.fn(async () => tools),
    callTool,
    close,
  };
  return { value, callTool, close };
}

function service(
  open: () => Promise<SandboxerCleanupTransport>,
  enabled = true,
) {
  const openTransport = vi.fn(open);
  const onReport = vi.fn();
  return {
    cleanup: new SandboxerPrCleanupService({
      store,
      openTransport,
      isEnabled: () => enabled,
      onReport,
      now: () => now,
    }),
    openTransport,
    onReport,
  };
}

const SANDBOXER_TOOLS = [
  "create_sandbox", "list_sandboxes", "exec", "read_file", "write_file",
  "host_port", "stop_sandbox", "resume_sandbox",
];

describe("ThreadSandboxStore", () => {
  it("keeps the first thread that created a sandbox as its owner", () => {
    created("sb_one", "thread-1");
    created("sb_one", "thread-2");
    expect(store.pendingForThread({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([{ sandboxId: "sb_one", status: "active" }]);
    expect(store.pendingForThread({ backend: "codex", threadId: "thread-2" }))
      .toEqual([]);
  });

  it("survives a restart", () => {
    const dbPath = stateDb.raw.name;
    created("sb_one");
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new ThreadSandboxStore(stateDb.raw);
    expect(store.threadIdsWithPending()).toEqual(["thread-1"]);
  });

  it("records one commit per created sandbox", async () => {
    const { writes } = await measureSqliteWrites(() => {
      created("sb_one", "thread-1", "pwragent-feat-x");
    });
    expectSqliteWriteBudget({
      note: "one observed create_sandbox result: 1 commit/~12.4 KB WAL per sandbox; ~0.6 MB/day at 50 sandboxes/day, zero idle writes",
      scenario: "thread-sandbox-record-created",
      writes,
    });
  });
});

describe("readCreatedSandbox", () => {
  it("reads Sandboxer's JSON text result", () => {
    expect(readCreatedSandbox(ok(JSON.stringify({
      id: "sb_jd777nc2gk",
      name: "pwragent-feat-pr-merge-close-wake",
      state: "ready",
    })))).toEqual({
      sandboxId: "sb_jd777nc2gk",
      name: "pwragent-feat-pr-merge-close-wake",
    });
  });

  it("reads structured content and ignores errors and other shapes", () => {
    expect(readCreatedSandbox({
      content: [],
      structuredContent: { sandboxId: "sb_abc" },
    })).toEqual({ sandboxId: "sb_abc" });
    expect(readCreatedSandbox(failure(JSON.stringify({ id: "sb_abc" }))))
      .toBeUndefined();
    expect(readCreatedSandbox(ok(JSON.stringify({ id: "../etc" }))))
      .toBeUndefined();
    expect(readCreatedSandbox(ok("created"))).toBeUndefined();
  });
});

describe("SandboxerPrCleanupService", () => {
  it("deletes each of the thread's sandboxes when the connection lists delete_sandbox", async () => {
    created("sb_one", "thread-1", "pwragent-feat-x");
    created("sb_two");
    created("sb_other", "thread-2");
    const connection = transport([...SANDBOXER_TOOLS, "delete_sandbox"]);
    const { cleanup, openTransport } = service(async () => connection.value);

    const report = await cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" });

    expect(report.entries).toEqual([
      { sandboxId: "sb_one", name: "pwragent-feat-x", action: "deleted" },
      { sandboxId: "sb_two", action: "deleted" },
    ]);
    expect(connection.callTool.mock.calls).toEqual([
      ["delete_sandbox", { sandboxId: "sb_one" }],
      ["delete_sandbox", { sandboxId: "sb_two" }],
    ]);
    expect(openTransport).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: CONNECTION,
      backend: "codex",
      threadId: "thread-1",
    }));
    expect(connection.close).toHaveBeenCalledOnce();
    expect(store.pendingForThread({ backend: "codex", threadId: "thread-1" })).toEqual([]);
    expect(store.pendingForThread({ backend: "codex", threadId: "thread-2" }))
      .toHaveLength(1);
  });

  it("stops instead when there is no delete tool, then deletes once one appears", async () => {
    created("sb_one");
    const today = transport(SANDBOXER_TOOLS);
    const first = service(async () => today.value);

    const stopped = await first.cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" });
    expect(stopped.entries).toMatchObject([{ sandboxId: "sb_one", action: "stopped" }]);
    expect(today.callTool.mock.calls).toEqual([["stop_sandbox", { sandboxId: "sb_one" }]]);
    expect(formatSandboxCleanupLines(stopped).join("\n"))
      .toContain("Deletion is pending: Sandboxer's MCP has no delete_sandbox tool");

    // Still no delete tool: nothing to call, still reported as pending.
    const again = transport(SANDBOXER_TOOLS);
    const second = service(async () => again.value);
    expect((await second.cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" })).entries)
      .toMatchObject([{ action: "pending-delete" }]);
    expect(again.callTool).not.toHaveBeenCalled();

    // Sandboxer ships delete_sandbox: the stopped sandbox is deleted.
    const later = transport([...SANDBOXER_TOOLS, "delete_sandbox"]);
    const third = service(async () => later.value);
    expect((await third.cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" })).entries)
      .toMatchObject([{ action: "deleted" }]);
    expect(store.threadIdsWithPending()).toEqual([]);
  });

  it("treats not found as already deleted", async () => {
    created("sb_gone");
    const connection = transport(
      [...SANDBOXER_TOOLS, "delete_sandbox"],
      async () => failure("sandbox sb_gone not found"),
    );
    const { cleanup } = service(async () => connection.value);

    expect((await cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" })).entries)
      .toMatchObject([{ sandboxId: "sb_gone", action: "already-gone" }]);
    expect(store.threadIdsWithPending()).toEqual([]);
  });

  it("leaves a sandbox in place and reports it when a call fails", async () => {
    created("sb_one");
    created("sb_two");
    const connection = transport(SANDBOXER_TOOLS, async (_name, args) => {
      if (args.sandboxId === "sb_one") return failure("not signed in");
      throw new Error("network unreachable");
    });
    const { cleanup, onReport } = service(async () => connection.value);

    const report = await cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" });
    expect(report.entries).toMatchObject([
      { sandboxId: "sb_one", action: "failed", detail: expect.stringContaining("not signed in") },
      { sandboxId: "sb_two", action: "failed", detail: expect.stringContaining("network unreachable") },
    ]);
    expect(onReport).toHaveBeenCalledWith(report);
    expect(store.pendingForThread({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([{ status: "active" }, { status: "active" }]);
  });

  it("leaves everything in place when Sandboxer is unavailable", async () => {
    created("sb_one");
    const { cleanup } = service(async () => {
      throw new Error("Sandboxer CLI is not installed");
    });
    expect((await cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" })).entries)
      .toMatchObject([{
        action: "failed",
        detail: expect.stringContaining("Sandboxer CLI is not installed"),
      }]);
    expect(store.threadIdsWithPending()).toEqual(["thread-1"]);
  });

  it("touches nothing when the operator turned cleanup off", async () => {
    created("sb_one");
    const { cleanup, openTransport } = service(async () => transport(SANDBOXER_TOOLS).value, false);
    expect((await cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" })).entries)
      .toMatchObject([{ action: "skipped" }]);
    expect(openTransport).not.toHaveBeenCalled();
    expect(store.threadIdsWithPending()).toEqual(["thread-1"]);
  });

  it("does nothing, and opens no session, for a thread that created no sandbox", async () => {
    const { cleanup, openTransport, onReport } = service(async () => transport(SANDBOXER_TOOLS).value);
    expect((await cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" })).entries)
      .toEqual([]);
    expect(openTransport).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();
  });

  it("leaves a sandbox created after the thread's last PR closed", async () => {
    created("sb_for_pr");
    now = 5_000;
    created("sb_later_work");
    const connection = transport(SANDBOXER_TOOLS);
    const { cleanup } = service(async () => connection.value);

    const report = await cleanup.cleanupThread({
      backend: "codex",
      threadId: "thread-1",
      createdBefore: 2_000,
    });
    expect(report.entries).toMatchObject([{ sandboxId: "sb_for_pr", action: "stopped" }]);
    expect(connection.callTool.mock.calls).toEqual([["stop_sandbox", { sandboxId: "sb_for_pr" }]]);
    expect(store.pendingForThread({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([
        { sandboxId: "sb_for_pr", status: "stopped" },
        { sandboxId: "sb_later_work", status: "active" },
      ]);
  });

  it("shares one run between concurrent callers", async () => {
    created("sb_one");
    const connection = transport(SANDBOXER_TOOLS);
    const { cleanup, openTransport } = service(async () => connection.value);
    const [a, b] = await Promise.all([
      cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" }),
      cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" }),
    ]);
    expect(a).toBe(b);
    expect(openTransport).toHaveBeenCalledOnce();
  });

  it("records one commit per released sandbox", async () => {
    created("sb_one");
    created("sb_two");
    const connection = transport(SANDBOXER_TOOLS);
    const { cleanup } = service(async () => connection.value);
    const { writes } = await measureSqliteWrites(async () => {
      await cleanup.cleanupThread({ backend: "codex", threadId: "thread-1" });
    });
    expectSqliteWriteBudget({
      note: "stop two sandboxes after a thread's PRs closed: 1 commit/~8 KB WAL per sandbox; ~0.4 MB/day at 50 sandboxes/day, zero idle writes",
      scenario: "thread-sandbox-cleanup-two",
      writes,
    });
  });
});
