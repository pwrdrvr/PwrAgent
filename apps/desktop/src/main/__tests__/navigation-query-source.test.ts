import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";

const mocks = vi.hoisted(() => ({
  store: {
    readNavigationSourceVersion: () => "unchanged",
    readNavigationQueryIndex: vi.fn(() => ({ threads: [], directories: [] })),
    readDirectoryGitStatusCache: async () => ({}),
  },
}));
vi.mock("../app-server/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.store }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: vi.fn() }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
import { loadLocalNavigationQueryIndex } from "../app-server/navigation-query-source";

function createSource() {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const listeners = new Set<(event: AgentEvent) => void>();
  const listThreads = vi.fn(async () => { await gate; return []; });
  const registry = {
    listThreads,
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    canonicalizeNavigationThreadPullRequests: async (threads: []) => threads,
    hydrateThreadGitWorkingStates: async (threads: []) => threads,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
  } as unknown as DesktopBackendRegistry;
  return {
    finish, listThreads, listeners,
    read: () => loadLocalNavigationQueryIndex({ registry, callerReason: "source-event-regression" }),
    emit: (method: string) => {
      const event = { backend: "codex", notification: { method, params: { threadId: "thread" } } } as AgentEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

describe("owner index source event admission", () => {
  it("shares pending index work across transcript-only events", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    source.emit("item/agentMessage/delta");
    source.emit("thread/tokenUsage/updated");
    const second = source.read();
    await Promise.resolve();
    source.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(await source.read()).toBe(a);
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    expect(source.listeners.size).toBe(1);
    source.emit("thread/name/updated");
    expect(source.listeners.size).toBe(0);
  });

  it("starts fresh owner work after a canonical navigation event", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    source.emit("thread/name/updated");
    const second = source.read();
    await Promise.resolve();
    source.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(source.listThreads).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
    expect(source.listeners.size).toBe(1);
    source.emit("thread/name/updated");
    expect(source.listeners.size).toBe(0);
  });
});
