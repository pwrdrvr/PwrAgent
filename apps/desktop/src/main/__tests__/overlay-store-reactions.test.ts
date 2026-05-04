import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-reactions-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteOverlayStore — thread reactions", () => {
  it("starts with no reactions on a thread that has never been touched", async () => {
    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay).toBeUndefined();
  });

  it("adds a reaction with present=true and surfaces it through getThreadOverlayState", async () => {
    const next = await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });

    expect(next.reactions).toEqual(["✅"]);

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.reactions).toEqual(["✅"]);
  });

  it("preserves insertion order when multiple reactions are added", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "👀",
      present: true,
    });
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "🚀",
      present: true,
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.reactions).toEqual(["👀", "✅", "🚀"]);
  });

  it("is idempotent — setting the same reaction twice does not duplicate", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });
    const next = await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });

    expect(next.reactions).toEqual(["✅"]);
  });

  it("removes a reaction with present=false and leaves the rest in order", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "👀",
      present: true,
    });
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "🚀",
      present: true,
    });

    const next = await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: false,
    });

    expect(next.reactions).toEqual(["👀", "🚀"]);
  });

  it("removing a reaction that was never present is a no-op", async () => {
    const next = await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "❌",
      present: false,
    });

    expect(next.reactions).toEqual([]);
  });

  it("scopes reactions per (backend, threadId) — same id on different backend is independent", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });
    await store.setThreadReaction({
      backend: "grok",
      threadId: "thread-1",
      emoji: "❌",
      present: true,
    });

    const codex = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    const grok = await store.getThreadOverlayState({
      backend: "grok",
      threadId: "thread-1",
    });

    expect(codex?.reactions).toEqual(["✅"]);
    expect(grok?.reactions).toEqual(["❌"]);
  });

  it("survives a database close + reopen", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "🎉",
      present: true,
    });

    const dbPath = path.join(tempDir, "state.db");
    stateDb.close();

    const reopened = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopened);
    const overlay = await reopenedStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.reactions).toEqual(["🎉"]);
    reopened.close();

    // Re-open the original handle so afterEach's close doesn't double-close.
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
  });
});
