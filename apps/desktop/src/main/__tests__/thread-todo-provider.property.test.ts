import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerBackendKind } from "@pwragent/shared";
import { resolveThreadTodoModelSettings } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { PwrAgentThreadTodoHandler } from "../agent-tools/pwragent-thread-todo-agent-tools";
import { buildPwrAgentThreadTodoToolDefinitions } from "../agent-tools/pwragent-thread-todo-agent-tools";
import * as appState from "../state/app-state";
import { getThreadTodoService, installThreadTodoRuntime, resetThreadTodoServiceForTests } from "../thread-todos/thread-todo-runtime";
import { ThreadTodoStore } from "../storage/thread-todo-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const providers = ["codex", "claude", "acp:kimi"] as const;
const models = { codex: "sol", claude: "opus", "acp:kimi": "kimi" };
const labels = { codex: "Sol", claude: "Opus 5.5", "acp:kimi": "Kimi" };

afterEach(() => { resetThreadTodoServiceForTests(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fixture(source: typeof providers[number] = "codex", db = openInMemoryStateDb()) {
  vi.spyOn(appState, "getAppStateDb").mockReturnValue(db);
  let handler: PwrAgentThreadTodoHandler;
  const registry = {
    onEvent: () => () => {},
    setPwrAgentThreadTodoHandler: (value: PwrAgentThreadTodoHandler) => { handler = value; },
    resolveThreadWorkspaceCwd: async () => "/repo/source-worktree",
    resolveThreadPrimaryDirectory: async () => undefined,
    readThreadHandoffSettings: async () => ({ model: models[source], reasoningEffort: "medium", executionMode: "auto" }),
    readBackendModelOptions: vi.fn(async (backend: keyof typeof models) => ({
      models: [{ id: models[backend], label: labels[backend], current: true, reasoningEfforts: ["medium", "high"] }],
    })),
    listBackends: vi.fn(async () => ({ backends: providers.map(kind => ({ kind, label: kind,
      available: true, capabilities: { createThread: true }, executionModes: [{ mode: "auto", available: true }] })) })),
    startThread: vi.fn(async (params: { backend: AppServerBackendKind }) => ({ backend: params.backend, threadId: "child" })),
    renameThread: async () => {},
    buildThreadTodoMessageOrigin: async () => undefined,
    startTurn: vi.fn(async () => ({ turnId: "turn" })),
  };
  installThreadTodoRuntime({ registry: registry as unknown as DesktopBackendRegistry,
    broadcast: () => {}, listProjects: async () => [], readDefaultMergeMethod: () => "squash",
    feed: { loadOwners: async () => [], managedThreadKeys: () => new Set(), onDelta: () => {} },
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = buildPwrAgentThreadTodoToolDefinitions(handler!).find(tool => tool.name === name)!;
    return await tool.dispatch(args, { backend: source, threadId: "source", transport: source === "codex" ? "codex_dynamic_tool" : "mcp" });
  };
  return { db, registry, call, service: getThreadTodoService(), store: new ThreadTodoStore(db) };
}

// The destination catalog is the oracle: a card must retain the chosen
// provider/model through public tool parsing, persistence, display and launch.
it("uses the proposed provider from either card tool through the first accepted turn", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(...providers), fc.constantFrom(...providers), fc.boolean(),
    async (source, destination, update) => {
      fc.pre(source !== destination);
      const f = fixture(source);
      try {
        const proposed = { backend: destination, model: labels[destination], reasoningEffort: "high" };
        const result = await f.call("add_todo", { title: "Follow up", key: "follow-up",
          action: { type: "start_thread", prompt: "Do the work", executionMode: "auto", workMode: "local",
            ...(update ? {} : proposed) } });
        expect(result.ok).toBe(true);
        if (update) expect((await f.call("update_todo", { key: "follow-up", ...proposed })).ok).toBe(true);
        const card = f.store.list({ status: "open" })[0]!;
        const settings = { backend: destination, model: models[destination], reasoningEffort: "high" };
        expect(card.action).toMatchObject(settings);
        // An older dispatch preference must not replace an explicit provider proposal.
        f.store.rememberDispatch(source, "source", { backend: source, model: models[source] }, { backend: source });
        const [visible] = await f.service.withDispatchDefaults([card]);
        expect(resolveThreadTodoModelSettings({ ...visible!.dispatchDefaults!, action: card.action }).settings).toEqual(settings);
        expect((await f.service.runAction(card.id, { seenExecutionMode: "auto" })).status).toBe("done");
        expect(f.registry.startThread).toHaveBeenCalledWith(expect.objectContaining({
          ...settings, cwd: "/repo/source-worktree", workMode: "local", executionMode: "auto",
        }));
        expect(f.registry.startTurn).toHaveBeenCalledWith(expect.objectContaining({ ...settings, executionMode: "auto" }));
      } finally { resetThreadTodoServiceForTests(); vi.restoreAllMocks(); f.db.close(); }
    }), { numRuns: 25 });
});

it("exposes destination backend on both public card schemas", () => {
  const definitions = buildPwrAgentThreadTodoToolDefinitions(undefined);
  const add = definitions.find(tool => tool.name === "add_todo")!.inputSchema as {
    properties: { action: { properties: Record<string, unknown> } };
  };
  const update = definitions.find(tool => tool.name === "update_todo")!.inputSchema as { properties: Record<string, unknown> };
  expect(add.properties.action.properties.backend).toMatchObject({ type: "string" });
  expect(update.properties.backend).toMatchObject({ type: "string" });
});

it("configures the reported Opus handoff for Auto in the source worktree within the card write budget", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("todo-cross-provider-");
  const f = fixture("codex", StateDb.open(temp.dbPath));
  try {
    const { writes } = await measureSqliteWrites(async () => {
      expect((await f.call("add_todo", { title: "Follow up", key: "follow-up", action: {
        type: "start_thread", prompt: "Do the work", executionMode: "auto", workMode: "local",
      } })).ok).toBe(true);
      expect((await f.call("update_todo", { key: "follow-up", backend: "claude", model: "Opus 5.5", reasoningEffort: "high" })).ok).toBe(true);
      const card = f.store.list({ status: "open" })[0]!;
      expect(new ThreadTodoStore(f.db).get(card.id)?.action).toMatchObject({
        backend: "claude", model: "opus", reasoningEffort: "high", executionMode: "auto", workMode: "local",
      });
      expect((await f.service.runAction(card.id, { seenExecutionMode: "auto" })).startedThread).toEqual({ backend: "claude", threadId: "child" });
    });
    expect(f.registry.startThread).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude", model: "opus", reasoningEffort: "high", executionMode: "auto", cwd: "/repo/source-worktree", workMode: "local",
    }));
    expectSqliteWriteBudget({ scenario: "thread-todo-cross-provider", writes,
      note: "One add, one provider update and one operator start: existing card and dispatch-preference writes only, no idle writes. ~0.05 MB/lifecycle, ~5 MB/day at 100 handoffs/day." });
  } finally { f.db.close(); }
  const reopened = StateDb.open(temp.dbPath);
  try {
    expect(new ThreadTodoStore(reopened).list({ status: "done" })[0]?.action).toMatchObject({
      backend: "claude", model: "opus", reasoningEffort: "high", executionMode: "auto", workMode: "local",
    });
  } finally { reopened.close(); removeTempStateDbDir(temp.tempDir); }
});

it.each([
  { backend: "unknown", model: "opus" },
  { backend: "acp:unregistered", model: "opus" },
  { backend: "claude", model: "sol" },
  { backend: "claude", model: "opus", reasoningEffort: "ultra" },
])("refuses invalid destinations atomically on add and update: %j", async (proposal) => {
  const f = fixture();
  try {
    const action = { type: "start_thread", prompt: "Go" };
    expect((await f.call("add_todo", { title: "Invalid", action: { ...action, ...proposal } })).ok).toBe(false);
    expect(f.store.list({ status: "open" })).toEqual([]);
    await f.call("add_todo", { title: "Valid", key: "valid", action });
    const before = f.store.list({ status: "open" })[0]!;
    expect((await f.call("update_todo", { key: "valid", ...proposal })).ok).toBe(false);
    expect(f.store.get(before.id)).toEqual(before);
    expect(f.registry.startThread).not.toHaveBeenCalled();
  } finally { f.db.close(); }
});

it("uses destination defaults without leaking the source model or effort, and can clear the provider", async () => {
  const f = fixture();
  try {
    expect((await f.call("add_todo", { title: "Defaults", key: "defaults",
      action: { type: "start_thread", prompt: "Go", backend: "claude" } })).ok).toBe(true);
    const card = f.store.list({ status: "open" })[0]!;
    expect(card.action).toEqual({ type: "start_thread", prompt: "Go", backend: "claude", model: "opus" });
    await f.service.runAction(card.id, { seenExecutionMode: "inherit" });
    expect(f.registry.startThread).toHaveBeenCalledWith(expect.objectContaining({ backend: "claude", model: "opus" }));
    expect(f.registry.startThread.mock.calls[0]![0]).not.toHaveProperty("reasoningEffort");
    f.service.resolve({ id: card.id, status: "open" });
    expect((await f.call("update_todo", { key: "defaults", backend: "", model: "", reasoningEffort: "" })).ok).toBe(true);
    expect(f.store.get(card.id)?.action).toEqual({ type: "start_thread", prompt: "Go" });
  } finally { f.db.close(); }
});

it("refuses unverifiable proposals and revalidates saved destinations before launch", async () => {
  const f = fixture();
  try {
    const input = { title: "Go", key: "go", action: { type: "start_thread", prompt: "Go", backend: "claude", model: "Opus 5.5" } };
    f.registry.readBackendModelOptions.mockResolvedValueOnce({ models: [] });
    expect((await f.call("add_todo", input)).ok).toBe(false);
    f.registry.readBackendModelOptions.mockRejectedValueOnce(new Error("Discovery failed"));
    expect((await f.call("add_todo", input)).ok).toBe(false);
    f.registry.readBackendModelOptions.mockResolvedValueOnce({ models: [{ id: "opus", label: "Opus 5.5", current: true, reasoningEfforts: [] }] });
    expect((await f.call("add_todo", { ...input, action: { ...input.action, reasoningEffort: "high" } })).ok).toBe(false);
    expect((await f.call("add_todo", input)).ok).toBe(true);
    const card = f.store.list({ status: "open" })[0]!;
    for (const failure of ["model", "catalog", "backend"] as const) {
      if (failure === "backend") f.registry.listBackends.mockResolvedValueOnce({ backends: [] });
      else f.registry.readBackendModelOptions.mockResolvedValueOnce({ models: failure === "model"
        ? [{ id: "replacement", label: "Replacement", current: true, reasoningEfforts: ["medium"] }]
        : [] });
      expect((await f.service.runAction(card.id, { seenExecutionMode: "inherit" })).status).toBe("open");
      expect(f.registry.startThread).not.toHaveBeenCalled();
      expect(f.store.get(card.id)?.action).toEqual(card.action);
    }
  } finally { f.db.close(); }
});
