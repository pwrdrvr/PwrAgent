import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { OwnerQueueEvents } from "../owner-queue-services";
import type {
  ThreadTodo,
  ThreadTodoFeedDelta,
  ThreadTodoFeedSnapshot,
} from "@pwragent/shared/contracts/thread-todos";
import {
  THREAD_TODOS_CHANGED_EVENT_CHANNEL, THREAD_TODOS_DELTA_EVENT_CHANNEL, THREAD_TODOS_LIST_CHANNEL,
  THREAD_TODOS_RESOLVE_CHANNEL, THREAD_TODOS_SNAPSHOT_CHANNEL, THREAD_REVIEWS_UPDATE_CHANNEL,
} from "../../shared/ipc";
import { unwrapNavigationRead } from "../../shared/navigation-ipc-result";

const fixture = vi.hoisted(() => {
  const target = { scope: "remote" as const, instanceId: "owner" };
  const windows = [undefined, target, { scope: "remote" as const, instanceId: "other" }].map((target) => ({
    target, isDestroyed: () => false, send: vi.fn(),
  }));
  const card: ThreadTodo = { id: "card", backend: "codex", threadId: "thread", title: "Owner card",
    kind: "reminder", status: "open", createdAt: 1, updatedAt: 1 };
  return {
    target, windows, card,
    handlers: new Map<string, (event: unknown, request?: unknown) => Promise<unknown>>(),
    localList: vi.fn(async () => ({ todos: [] })),
    localResolve: vi.fn(),
    localSnapshot: vi.fn(async (): Promise<ThreadTodoFeedSnapshot> => ({ epoch: "local", revision: 0, todos: [] })),
    supportsFeed: vi.fn(() => false),
    watchFeeds: vi.fn(),
    remote: vi.fn(async (_target: unknown, operation: string) => operation === "listTodos" ? { todos: [card] } : { todo: card }),
    peerStatusListener: undefined as (() => void) | undefined,
    remoteListener: undefined as ((event: AgentEvent) => void) | undefined,
  };
});

vi.mock("electron", () => ({ ipcMain: {
  removeHandler: (channel: string) => fixture.handlers.delete(channel),
  handle: (channel: string, handler: (event: unknown, request?: unknown) => Promise<unknown>) => fixture.handlers.set(channel, handler),
} }));
vi.mock("../federation/federation-runtime", () => ({ getDesktopFederationRuntime: () => ({
  requestThreadTodoOperation: fixture.remote, remotePeerSupportsTodoFeed: fixture.supportsFeed,
  setTodoFeedWatches: fixture.watchFeeds,
  onPeerStatusChanged: (listener: () => void) => { fixture.peerStatusListener = listener; return () => {}; },
  onRemoteBackendEvent: (listener: (event: AgentEvent) => void) => { fixture.remoteListener = listener; return () => {}; },
}) }));
vi.mock("../thread-todos/thread-todo-operations", () => ({ localThreadTodoOperations: {
  listTodos: fixture.localList, resolveTodo: fixture.localResolve, snapshotFeed: fixture.localSnapshot,
} }));
vi.mock("../storage/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => ({ listRemoteThreadPins: async () => [] }) }));
vi.mock("../log", () => ({ getMainLogger: () => ({ warn: vi.fn() }) }));

import { registerThreadTodoIpcHandlers } from "../shell/ipc/thread-todos-ipc";
import { mainWindowEventChannels } from "../shell/main-window-channels";
import { WINDOW_KIND_MAIN, _resetWindowChannelsForTests, registerWindowChannels } from "../shell/window-channels";

const events: OwnerQueueEvents = new EventEmitter();

// The real registry, fed the channels createMainWindow registers, so a
// window missing a channel misses its broadcasts here as it does in the app.
function registerTestWindows(): void {
  _resetWindowChannelsForTests();
  for (const window of fixture.windows) {
    registerWindowChannels({ webContents: window, on: () => {} } as unknown as BrowserWindow,
      WINDOW_KIND_MAIN, mainWindowEventChannels(window.target), window.target);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  registerTestWindows();
  registerThreadTodoIpcHandlers(events);
});

describe("owner-routed To-do IPC", () => {
  it("infers the owner from a remote window's sender and sends mutations only there", async () => {
    const sender = fixture.windows[1];
    const result = await fixture.handlers.get(THREAD_TODOS_LIST_CHANNEL)!({ sender }, { status: "open" }) as { todos: ThreadTodo[] };
    expect(result.todos[0]).toMatchObject({ federationTarget: fixture.target });
    expect(fixture.remote).toHaveBeenCalledWith(fixture.target, "listTodos", { status: "open" });
    expect(fixture.localList).not.toHaveBeenCalled();
    await fixture.handlers.get(THREAD_TODOS_RESOLVE_CHANNEL)!({ sender }, { id: result.todos[0]!.id, status: "dismissed" });
    expect(fixture.remote).toHaveBeenLastCalledWith(fixture.target, "resolveTodo", { id: "card", status: "dismissed" });
    expect(fixture.localResolve).not.toHaveBeenCalled();
    await fixture.handlers.get(THREAD_REVIEWS_UPDATE_CHANNEL)!({ sender }, { id: "review", itemId: "finding", status: "addressed" });
    expect(fixture.remote).toHaveBeenLastCalledWith(fixture.target, "updateReview", { id: "review", itemId: "finding", status: "addressed" });
  });

  // A busy owner is expected contention, not a failed handler: it crosses IPC
  // as data, so Electron never wraps it as "Error invoking remote method".
  it("returns a remote owner's navigation_busy listing as an expected failure", async () => {
    const busy = Object.assign(new Error("handler_failed: [navigation_busy] Navigation changed during its owner read."), {
      code: "handler_failed",
    });
    fixture.remote.mockRejectedValueOnce(busy);
    const result = await fixture.handlers.get(THREAD_TODOS_LIST_CHANNEL)!({ sender: fixture.windows[1] }, { status: "open" });
    expect(result).toEqual({ navigationReadFailure: true, code: "navigation_busy", message: busy.message });
    expect(() => unwrapNavigationRead(result)).toThrow(expect.objectContaining({ code: "navigation_busy" }));
  });

  it("still rejects a remote owner's unexpected listing failure", async () => {
    fixture.remote.mockRejectedValueOnce(Object.assign(new Error("handler_failed: Unexpected failure"), { code: "handler_failed" }));
    await expect(fixture.handlers.get(THREAD_TODOS_LIST_CHANNEL)!({ sender: fixture.windows[1] }, { status: "open" }))
      .rejects.toThrow("handler_failed: Unexpected failure");
  });

  it("refreshes local mounted viewers and the correct remote window after owner changes and reconnect", () => {
    fixture.remoteListener!({ backend: "codex", federationTarget: fixture.target,
      notification: { method: "thread/todos/changed", params: { backend: "codex", threadId: "thread", at: 1 } } });
    for (const window of fixture.windows.slice(0, 2)) {
      expect(window.send).toHaveBeenCalledWith(THREAD_TODOS_CHANGED_EVENT_CHANNEL, {
        backend: "codex", threadId: "thread", at: 1, federationTarget: fixture.target,
      });
    }
    expect(fixture.windows[2]!.send).not.toHaveBeenCalled();
    fixture.peerStatusListener!();
    expect(fixture.windows[1]!.send).toHaveBeenLastCalledWith(THREAD_TODOS_CHANGED_EVENT_CHANNEL, { at: expect.any(Number) });
    fixture.remoteListener!({ backend: "codex", federationTarget: fixture.target,
      notification: { method: "federation/eventStream/changed", params: {} } } as AgentEvent);
    expect(fixture.windows[1]!.send).toHaveBeenLastCalledWith(THREAD_TODOS_CHANGED_EVENT_CHANNEL, {
      at: expect.any(Number), federationTarget: fixture.target,
    });
  });

  it("sends local invalidations only to local windows", () => {
    events.emit("threadTodosChanged", { backend: "codex", threadId: "local-thread", at: 2 });
    expect(fixture.windows[0]!.send).toHaveBeenCalledOnce();
    expect(fixture.windows[1]!.send).not.toHaveBeenCalled();
  });

  // A local provider refresh names no backend. It must not make a viewer
  // re-read its owner's cards over federation.
  it("keeps untargeted local invalidations out of remote windows", () => {
    events.emit("threadTodosChanged", { at: 3 });
    expect(fixture.windows[0]!.send).toHaveBeenCalledOnce();
    expect(fixture.windows[1]!.send).not.toHaveBeenCalled();
    expect(fixture.windows[2]!.send).not.toHaveBeenCalled();
  });

  it("serves each window its own view and sends local deltas only to the main window", async () => {
    const card: ThreadTodo = { ...fixture.card, id: "local-card" };
    const main = await fixture.handlers.get(THREAD_TODOS_SNAPSHOT_CHANNEL)!({ sender: fixture.windows[0] }) as ThreadTodoFeedSnapshot;
    expect(fixture.localSnapshot).toHaveBeenCalledOnce();
    const remote = await fixture.handlers.get(THREAD_TODOS_SNAPSHOT_CHANNEL)!({ sender: fixture.windows[1] }) as ThreadTodoFeedSnapshot;
    expect(fixture.remote).toHaveBeenCalledWith(fixture.target, "listTodos", { status: "open" });
    expect(remote.todos.map((todo) => todo.id)).toEqual(["remote-todo:owner:card"]);
    // A relayed owner's feed is followed once it acknowledges this watch.
    expect(fixture.watchFeeds).toHaveBeenLastCalledWith(["owner"]);
    const delta: ThreadTodoFeedDelta = { epoch: "local", revision: 1, backend: "codex", threadId: "thread", upserts: [card] };
    events.emit("threadTodoDelta", delta);
    const sent = (window: (typeof fixture.windows)[number]) => window.send.mock.calls
      .filter(([channel]) => channel === THREAD_TODOS_DELTA_EVENT_CHANNEL).map(([, payload]) => payload);
    expect(sent(fixture.windows[0]!)).toEqual([{ epoch: main.epoch, revision: main.revision + 1, upserts: [card] }]);
    expect(sent(fixture.windows[1]!)).toEqual([]);
    expect(sent(fixture.windows[2]!)).toEqual([]);
  });
});
