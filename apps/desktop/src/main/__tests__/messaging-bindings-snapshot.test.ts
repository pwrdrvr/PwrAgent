import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type { AppServerThreadSummary, NavigationThreadSummary } from "@pwragent/shared";

const mocks = vi.hoisted(() => ({
  available: true,
  messaging: {
    findActiveBindings: vi.fn(async (): Promise<MessagingBindingRecord[]> => []),
    findActiveBindingsForThread: vi.fn(
      async (_params: { backend: string; threadId: string }): Promise<MessagingBindingRecord[]> => [],
    ),
  },
}));
vi.mock("../messaging/desktop-messaging-store", () => ({
  getDesktopMessagingStore: () => {
    if (!mocks.available) throw new Error("App state not initialized.");
    return mocks.messaging;
  },
}));
import {
  buildMessagingBindingsByThreadKey,
  buildNavigationIndexMessagingBindings,
} from "../messaging/messaging-bindings-snapshot";
import {
  compareBindingsByCreation,
  isBindingForThread,
} from "../messaging/core/messaging-binding-thread-match";

function thread(id: string, source: AppServerThreadSummary["source"] = "codex"): NavigationThreadSummary {
  return { id, source, title: id, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true } };
}

function binding(
  id: string,
  threadId: string,
  extra: Partial<MessagingBindingRecord> = {},
): MessagingBindingRecord {
  return {
    id,
    threadId,
    backend: "codex",
    authorizedActorIds: [],
    createdAt: 1,
    updatedAt: 1,
    channel: { channel: "telegram", conversation: { kind: "topic", id: `${id}:topic`, title: id } },
    ...extra,
  } as MessagingBindingRecord;
}

const chipIds = (chips: Array<{ bindingId: string }> | undefined) => chips?.map((chip) => chip.bindingId);

/** Serve both store queries from the same rows, as the SQLite store does. */
function storeRows(rows: MessagingBindingRecord[]): void {
  mocks.messaging.findActiveBindings.mockResolvedValue(rows);
  mocks.messaging.findActiveBindingsForThread.mockImplementation(async (params) =>
    rows.filter((row) => isBindingForThread(row, params as Parameters<typeof isBindingForThread>[1])));
}

afterEach(() => {
  mocks.available = true;
  mocks.messaging.findActiveBindings.mockReset().mockResolvedValue([]);
  mocks.messaging.findActiveBindingsForThread.mockReset().mockResolvedValue([]);
});

describe("isBindingForThread", () => {
  it("matches the thread id and the backend, or a binding with no backend", () => {
    const target = { backend: "codex" as const, threadId: "t" };
    expect(isBindingForThread({ backend: "codex", threadId: "t" }, target)).toBe(true);
    expect(isBindingForThread({ backend: undefined as never, threadId: "t" }, target)).toBe(true);
    expect(isBindingForThread({ backend: "acp:grok", threadId: "t" }, target)).toBe(false);
    expect(isBindingForThread({ backend: "codex", threadId: "other" }, target)).toBe(false);
  });

  it("orders by creation, then id", () => {
    const rows = [
      { id: "b", createdAt: 2 },
      { id: "c", createdAt: 1 },
      { id: "a", createdAt: 2 },
    ];
    expect(rows.sort(compareBindingsByCreation).map((row) => row.id)).toEqual(["c", "a", "b"]);
  });
});

describe("buildMessagingBindingsByThreadKey", () => {
  it("reads the store once for every thread and groups by thread identity", async () => {
    storeRows([
      // The store lists by updated_at DESC; chips stay in creation order.
      binding("bound-late", "bound", { createdAt: 5, updatedAt: 9 }),
      binding("bound-early", "bound", { createdAt: 2, updatedAt: 3 }),
      binding("legacy", "shared", { backend: undefined as never }),
      binding("grok-only", "shared", { backend: "acp:grok" }),
      binding("remote", "bound", {
        federatedThread: { target: { scope: "remote", instanceId: "peer" }, backend: "codex", threadId: "bound" },
      } as Partial<MessagingBindingRecord>),
    ]);

    const result = await buildMessagingBindingsByThreadKey([
      thread("bound"),
      thread("shared"),
      thread("shared", "acp:grok"),
      thread("unbound"),
    ]);

    expect(mocks.messaging.findActiveBindings).toHaveBeenCalledTimes(1);
    expect(mocks.messaging.findActiveBindingsForThread).not.toHaveBeenCalled();
    expect(Object.keys(result ?? {}).sort()).toEqual(["acp:grok:shared", "codex:bound", "codex:shared"]);
    expect(chipIds(result?.["codex:bound"])).toEqual(["bound-early", "bound-late"]);
    expect(chipIds(result?.["codex:shared"])).toEqual(["legacy"]);
    expect(chipIds(result?.["acp:grok:shared"])).toEqual(["grok-only", "legacy"]);
  });

  it("returns undefined when nothing is bound, with no threads, or without a store", async () => {
    storeRows([binding("elsewhere", "other")]);
    await expect(buildMessagingBindingsByThreadKey([thread("bound")])).resolves.toBeUndefined();
    await expect(buildMessagingBindingsByThreadKey([thread("bound"), thread("unbound")]))
      .resolves.toBeUndefined();

    mocks.messaging.findActiveBindings.mockClear();
    mocks.messaging.findActiveBindingsForThread.mockClear();
    await expect(buildMessagingBindingsByThreadKey([])).resolves.toBeUndefined();
    expect(mocks.messaging.findActiveBindings).not.toHaveBeenCalled();
    expect(mocks.messaging.findActiveBindingsForThread).not.toHaveBeenCalled();

    mocks.available = false;
    await expect(buildMessagingBindingsByThreadKey([thread("bound")])).resolves.toBeUndefined();

    mocks.available = true;
    mocks.messaging.findActiveBindings.mockRejectedValue(new Error("database is locked"));
    mocks.messaging.findActiveBindingsForThread.mockRejectedValue(new Error("database is locked"));
    await expect(buildMessagingBindingsByThreadKey([thread("bound")])).resolves.toBeUndefined();
    await expect(buildMessagingBindingsByThreadKey([thread("bound"), thread("unbound")]))
      .resolves.toBeUndefined();
  });

  it("reads only the selected thread's rows for a single-thread detail", async () => {
    storeRows([
      binding("late", "bound", { createdAt: 3 }),
      binding("early", "bound", { createdAt: 1 }),
      binding("elsewhere", "other"),
    ]);

    const detail = await buildMessagingBindingsByThreadKey([thread("bound")]);

    expect(mocks.messaging.findActiveBindingsForThread).toHaveBeenCalledTimes(1);
    expect(mocks.messaging.findActiveBindingsForThread).toHaveBeenCalledWith({ backend: "codex", threadId: "bound" });
    expect(mocks.messaging.findActiveBindings).not.toHaveBeenCalled();
    expect(Object.keys(detail ?? {})).toEqual(["codex:bound"]);
    expect(chipIds(detail?.["codex:bound"])).toEqual(["early", "late"]);
  });
});

describe("buildNavigationIndexMessagingBindings", () => {
  it("gives the sidebar row the same chips, in the same order, as the selected detail", async () => {
    storeRows([
      binding("third", "bound", { createdAt: 3, updatedAt: 1 }),
      binding("first", "bound", { createdAt: 1, updatedAt: 3 }),
      binding("second-b", "bound", { createdAt: 2, updatedAt: 2 }),
      binding("second-a", "bound", { createdAt: 2, updatedAt: 2 }),
    ]);

    const detail = await buildMessagingBindingsByThreadKey([thread("bound")]);
    const index = await buildNavigationIndexMessagingBindings([thread("bound"), thread("unbound")]);

    expect(index.get("codex:bound")).toEqual(detail?.["codex:bound"]);
    expect(chipIds(index.get("codex:bound"))).toEqual(["first", "second-a", "second-b", "third"]);
    expect(index.has("codex:unbound")).toBe(false);
    // The detail runs the per-thread query and the index the full read.
    expect(mocks.messaging.findActiveBindingsForThread).toHaveBeenCalledTimes(1);
    expect(mocks.messaging.findActiveBindings).toHaveBeenCalledTimes(1);
  });

  it("gives a peer's row none of this machine's bindings", async () => {
    storeRows([binding("local", "shared")]);
    const remote = {
      ...thread("shared"),
      federation: {
        ref: { target: { scope: "remote", instanceId: "peer" }, backend: "codex", threadId: "shared" },
        instanceLabel: "Peer",
      },
    } as NavigationThreadSummary;

    const index = await buildNavigationIndexMessagingBindings([remote]);

    expect(index.size).toBe(0);
  });

  it("returns an empty map without reading when there are no threads, and when the read fails", async () => {
    await expect(buildNavigationIndexMessagingBindings([])).resolves.toEqual(new Map());
    expect(mocks.messaging.findActiveBindings).not.toHaveBeenCalled();

    mocks.messaging.findActiveBindings.mockRejectedValue(new Error("database is locked"));
    await expect(buildNavigationIndexMessagingBindings([thread("bound"), thread("unbound")]))
      .resolves.toEqual(new Map());
  });
});
