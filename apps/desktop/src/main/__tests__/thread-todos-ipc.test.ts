import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationDirectorySummary, ThreadTodo, ThreadTodosChangedEvent } from "@pwragent/shared";
import {
  THREAD_TODOS_CHANGED_EVENT_CHANNEL, THREAD_TODOS_LIST_CHANNEL, THREAD_TODOS_RESOLVE_CHANNEL,
  THREAD_REVIEWS_UPDATE_CHANNEL,
} from "../../shared/ipc";

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
    remote: vi.fn(async (_target: unknown, operation: string) => operation === "listTodos" ? { todos: [card] } : { todo: card }),
    publish: vi.fn(),
    peerStatusListener: undefined as (() => void) | undefined,
    remoteListener: undefined as ((event: AgentEvent) => void) | undefined,
    broadcast: undefined as ((event: ThreadTodosChangedEvent) => void) | undefined,
    listProjects: undefined as (() => Promise<unknown[]>) | undefined,
    loadIndex: vi.fn(),
  };
});

vi.mock("electron", () => ({ ipcMain: {
  removeHandler: (channel: string) => fixture.handlers.delete(channel),
  handle: (channel: string, handler: (event: unknown, request?: unknown) => Promise<unknown>) => fixture.handlers.set(channel, handler),
} }));
vi.mock("../federation/federation-runtime", () => ({ getDesktopFederationRuntime: () => ({
  requestThreadTodoOperation: fixture.remote, publishThreadTodosChanged: fixture.publish,
  onPeerStatusChanged: (listener: () => void) => { fixture.peerStatusListener = listener; return () => {}; },
  onRemoteBackendEvent: (listener: (event: AgentEvent) => void) => { fixture.remoteListener = listener; return () => {}; },
}) }));
vi.mock("../thread-todos/thread-todo-operations", () => ({ localThreadTodoOperations: {
  listTodos: fixture.localList, resolveTodo: fixture.localResolve,
} }));
vi.mock("../thread-todos/thread-todo-runtime", () => ({
  installThreadTodoRuntime: (options: {
    broadcast: (event: ThreadTodosChangedEvent) => void;
    listProjects: () => Promise<unknown[]>;
  }) => {
    fixture.broadcast = options.broadcast;
    fixture.listProjects = options.listProjects;
  },
}));
vi.mock("../app-server/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => ({ listRemoteThreadPins: async () => [] }) }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({}) }));
vi.mock("../settings/desktop-settings-singleton", () => ({ getDesktopSettingsService: () => ({}) }));
vi.mock("../app-server/navigation-query-source", () => ({ loadLocalNavigationQueryIndex: fixture.loadIndex }));
vi.mock("../log", () => ({ getMainLogger: () => ({ warn: vi.fn() }) }));

import { registerThreadTodoIpcHandlers } from "../ipc/thread-todos-ipc";
import { mainWindowEventChannels } from "../main-window-channels";
import { WINDOW_KIND_MAIN, _resetWindowChannelsForTests, registerWindowChannels } from "../window-channels";

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
  registerThreadTodoIpcHandlers();
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

  it("publishes local invalidations to federation without leaking local cards into remote windows", () => {
    fixture.broadcast!({ backend: "codex", threadId: "local-thread", at: 2 });
    expect(fixture.publish).toHaveBeenCalledWith({ backend: "codex", threadId: "local-thread", at: 2 });
    expect(fixture.windows[0]!.send).toHaveBeenCalledOnce();
    expect(fixture.windows[1]!.send).not.toHaveBeenCalled();
  });

  // A local provider refresh names no backend. It must not make a viewer
  // re-read its owner's cards over federation.
  it("keeps untargeted local invalidations out of remote windows", () => {
    fixture.broadcast!({ at: 3 });
    expect(fixture.windows[0]!.send).toHaveBeenCalledOnce();
    expect(fixture.windows[1]!.send).not.toHaveBeenCalled();
    expect(fixture.windows[2]!.send).not.toHaveBeenCalled();
  });

  // The Directories lens can hold more projects than one navigation page.
  // A project past the first page must still be one a card can name.
  it("lists every local project for a card, past one navigation page", async () => {
    const directories: NavigationDirectorySummary[] = Array.from({ length: 150 }, (_, index) => ({
      key: `directory:${index}`, kind: "directory", label: `Project ${index}`, path: `/project/${index}`,
      threadKeys: [], needsAttentionCount: 0,
    }));
    fixture.loadIndex.mockResolvedValue({ directories, threads: [] });
    const projects = await fixture.listProjects!();
    expect(projects).toHaveLength(150);
    expect(projects).toContainEqual({ key: "directory:149", label: "Project 149", kind: "directory", path: "/project/149" });
  });
});
