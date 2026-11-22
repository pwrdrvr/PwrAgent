import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { ClaudeBackend, type ClaudeBackendOptions } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { claudeEnvironment } from "../claude/claude-executable";

const roots: string[] = [];
const backends: ClaudeBackend[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Synthetic SDK only: discovery, authentication and query never launch a CLI. */
async function fixture(messages: (options: Options) => AsyncGenerator<SDKMessage>, controls: Partial<Query> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-code-transcript-"));
  roots.push(root);
  const events: AgentEvent[] = [];
  const queries: Options[] = [];
  const completion = Promise.withResolvers<void>();
  const backendOptions: ClaudeBackendOptions = {
    store: new ClaudeSessionStore(root),
    query: ((args: Parameters<typeof query>[0]) => {
      queries.push(args.options!);
      return Object.assign(messages(args.options!), { close: vi.fn(), setPermissionMode: vi.fn().mockResolvedValue(undefined), ...controls }) as unknown as Query;
    }) as typeof query,
    getSessionInfo: vi.fn().mockResolvedValue(undefined),
    discoverModels: vi.fn().mockResolvedValue([]),
    inspectInstallation: vi.fn().mockResolvedValue({ executable: "/fixture/claude", authStatus: "signed-in" }),
    resolveEnv: async () => ({ PATH: "/fixture" }),
    emit: async (event) => {
      events.push(event);
      if (["turn/completed", "turn/failed", "turn/cancelled"].includes(event.notification.method)) completion.resolve();
    },
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
  };
  function openBackend(options = backendOptions) {
    const backend = new ClaudeBackend(options);
    backends.push(backend);
    return backend;
  }
  return { root, events, queries, backendOptions, openBackend, backend: openBackend(), waitForTurn: () => completion.promise };
}

const init = { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
const result = { type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage;
const call = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant", parent_tool_use_id: null, message: { id: `message-${id}`, content: [{ type: "tool_use", id, name, input }] },
}) as SDKMessage;
const answer = (id: string, content: string, toolUseResult?: unknown) => ({
  type: "user", parent_tool_use_id: null, tool_use_result: toolUseResult,
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
}) as SDKMessage;

// Oracle: provider order, projecting only roots and direct children of REPL.
it("projects Code and its direct tools without admitting Agent descendants", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("Bash", "Read", "Edit", "mcp__fixture__lookup"),
    { minLength: 4, maxLength: 12 }), async (generated) => {
    const names = ["Bash", "Read", "Edit", "mcp__fixture__lookup", ...generated];
    const f = await fixture(async function* () {
      yield init;
      yield call("code", "REPL", { code: "const secretScript = true;" });
      yield call("agent", "Agent", { prompt: "Investigate" });
      yield call("root-bash", "Bash", { command: "echo root" });
      yield answer("root-bash", "root output");
      for (const [index, name] of names.entries()) {
        const input = name === "Bash" ? { command: "echo fixture" } : { file_path: "/fixture/a.ts" };
        yield { ...call(`nested-${index}`, name, input), parent_tool_use_id: "code" } as SDKMessage;
        yield { ...call(`hidden-${index}`, name, input), parent_tool_use_id: "agent" } as SDKMessage;
        yield { ...call(`unknown-${index}`, name, input), parent_tool_use_id: "unknown" } as SDKMessage;
        yield { ...call(`grandchild-${index}`, name, input), parent_tool_use_id: "nested-0" } as SDKMessage;
        yield answer(`nested-${index}`, "done", name === "Edit" ? {
          filePath: "/fixture/a.ts", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
        } : undefined);
      }
      yield answer("code", "done");
      yield result;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Run fixture" }] });
    await f.waitForTurn();
    const started = f.events.flatMap((e) => e.notification.method === "item/started" ? [e.notification.params.item as { id: string }] : []);
    expect(started.map((item) => item.id)).toEqual(["code", "agent", "root-bash", ...names.map((_, i) => `nested-${i}`)]);
    const rows = (await f.backend.readThread(threadId)).entries.filter((entry) => entry.type === "activity");
    const code = rows.find((row) => row.id === "code")!;
    expect(code.summary).toBe("Code");
    expect(code.details[0].command?.displayCommand).toContain("const secretScript = true;");
    const details = rows.flatMap((row) => row.details);
    names.forEach((name, index) => {
      const detail = details.find((d) => d.id === `nested-${index}`)!;
      expect(detail).toBeDefined();
      if (name === "Edit") expect(detail.fileDiff).toBeDefined();
      if (name === "Bash") expect(detail.command?.rawCommand).toBe("echo fixture");
      if (name === "Read") expect(detail.label).toBe("Read a.ts");
    });
    expect(f.queries[0].allowedTools ?? []).not.toContain("REPL");
    expect(f.queries[0].allowedTools ?? []).not.toContain("Bash");
    await f.backend.close();
  }), { numRuns: 10 });
});

it.each([0, 3999, 4000, 4001, 8000])("caps the expanded Code script at 4000 characters (%s)", async (length) => {
  const script = "x".repeat(length);
  const f = await fixture(async function* () {
    yield init; yield call("code", "REPL", { code: script }); yield answer("code", "done"); yield result;
  });
  const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
  await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Run fixture" }] });
  await f.waitForTurn();
  const rows = (await f.backend.readThread(threadId)).entries.filter((entry) => entry.type === "activity");
  expect(rows[0].summary).toBe("Code");
  const preview = rows[0].details[0].command!.displayCommand;
  expect(preview).toContain("x".repeat(Math.min(length, 4000)));
  expect(preview).not.toContain("x".repeat(4001));
  expect(preview.includes("truncated")).toBe(length > 4000);
});

it("lists a REPL background task as Code and stops the CLI task id", async () => {
  const stopTask = vi.fn().mockResolvedValue(undefined);
  const f = await fixture(async function* (options) {
    yield init;
    yield call("code", "REPL", { code: "privateScript()" });
    yield { type: "system", subtype: "task_started", task_id: "code-task", tool_use_id: "code",
      description: "privateScript()", task_type: "repl", is_backgrounded: true } as SDKMessage;
    yield answer("code", "running", { backgroundTaskId: "code-task" });
    yield result;
    await new Promise<void>((resolve) => {
      options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }, { stopTask });
  const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
  await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Run fixture" }] });
  await f.waitForTurn();
  expect(f.backend.listBackgroundTasks(threadId).terminals).toMatchObject([
    { itemId: "code", processId: "code-task", command: "Code" },
  ]);
  await expect(f.backend.stopBackgroundTask(threadId, "code-task")).resolves.toBe(true);
  expect(stopTask).toHaveBeenCalledWith("code-task");
});

it("sends nested Bash through the same canUseTool approval as a root Bash", async () => {
  const decisions: unknown[] = [];
  const f = await fixture(async function* (options) {
    yield init;
    yield call("code", "REPL", { code: "await bash()" });
    yield { ...call("nested", "Bash", { command: "echo fixture" }), parent_tool_use_id: "code" } as SDKMessage;
    const context = { signal: new AbortController().signal, toolUseID: "nested", requestId: "nested-request" };
    decisions.push(await options.canUseTool!("Bash", { command: "echo fixture" }, context));
    decisions.push(await options.canUseTool!("Bash", { command: "echo fixture" }, { ...context, toolUseID: "root" }));
    yield result;
  });
  const request = vi.fn().mockResolvedValue({ decision: "decline" });
  const backend = f.openBackend({ ...f.backendOptions, request });
  const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
  await backend.startTurn({ threadId, input: [{ type: "text", text: "Run fixture" }] });
  await f.waitForTurn();
  expect(decisions).toMatchObject([{ behavior: "deny" }, { behavior: "deny" }]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([notification]) => notification.method))
    .toEqual(["item/commandExecution/requestApproval", "item/commandExecution/requestApproval"]);
});

it("does not enable experimental Code Mode in the CLI environment", () => {
  expect(claudeEnvironment({})).not.toHaveProperty("CLAUDE_CODE_EXPERIMENTAL_CODE_MODE");
  expect(claudeEnvironment({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "0" }).CLAUDE_CODE_EXPERIMENTAL_CODE_MODE).toBe("0");
});

