import fc from "fast-check";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import type { AppServerBackendKind, AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

function provider(id: string, source: AppServerBackendKind = "codex"): AppServerThreadSummary {
  return { source, id, title: id, titleSource: "explicit", threadStatus: "idle", createdAt: 1, updatedAt: 1, linkedDirectories: [] };
}

function visibleThreads(store: SqliteOverlayStore, threads: AppServerThreadSummary[]): string[] {
  return store.readNavigationQueryIndex({ backend: "all", threads }).threads.map(({ id }) => id);
}

it("uses point lookups on the warm managed-worker set regardless of unrelated history", () => {
  const state = StateDb.open(":memory:");
  try {
    const store = new SqliteOverlayStore(state);
    const write = state.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)");
    const clearCards = state.raw.prepare("DELETE FROM thread_sub_agents WHERE thread_id = ?");
    const threads = [provider("ordinary"), provider("worker"), provider("handoff")];
    write.run("codex:handoff", JSON.stringify({
      backend: "codex", threadId: "handoff", handoffOrigin: { groupingMode: "subthread" },
    }));
    fc.assert(fc.property(fc.integer({ min: 0, max: 256 }), (history) => {
      clearCards.run("codex:parent");
      write.run("codex:parent", JSON.stringify({ backend: "codex", threadId: "parent", subAgents: [
        { monitorId: "worker", monitorThreadId: "worker" },
        { monitorId: "handoff", monitorThreadId: "handoff" },
        ...Array.from({ length: history }, (_, i) => ({ monitorId: "history:" + i, monitorThreadId: "history:" + i })),
      ] }));
      expect(visibleThreads(store, threads)).toEqual(["ordinary", "handoff"]);
      const iterator = vi.spyOn(store["managedSubAgentThreadKeysCache"]!.keys, Symbol.iterator);
      try {
        expect(visibleThreads(store, threads)).toEqual(["ordinary", "handoff"]);
        expect(iterator).not.toHaveBeenCalled();
      } finally {
        iterator.mockRestore();
      }
    }), { numRuns: 25, examples: [[0]] });
  } finally {
    state.close();
  }
});

it("matches worker and handoff visibility across external commits and savepoint rollbacks", () => {
  const temp = createTempStateDb("pwragent-navigation-managed-membership-");
  const state = StateDb.open(temp.dbPath);
  const writer = new Database(temp.dbPath);
  try {
    const store = new SqliteOverlayStore(state);
    const threads = [
      provider("ordinary"), provider("card:0", "acp:grok"), provider("card:1", "acp:grok"),
      provider("legacy:0", "acp:grok"), provider("legacy:1", "acp:grok"), provider("after-malformed", "acp:grok"),
      provider("parent", "acp:grok"),
    ];
    const write = (db: Database.Database, active: number, grouped: boolean) => {
      // An older profile writer captures a card with an encoded parent key
      // and a whitespace-padded worker ID. The legacy projection also keeps
      // its valid prefix when an imported array contains a malformed entry.
      const put = db.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)");
      put.run("acp%3Agrok:parent", JSON.stringify({ backend: "acp:grok", threadId: "parent", subAgents: [
        { monitorId: "worker", monitorThreadId: "\u2003card:" + active + "\t" },
        { monitorId: "self", monitorThreadId: "parent" },
      ] }));
      db.prepare("INSERT OR REPLACE INTO thread_navigation_relationships VALUES (?, ?, 0)")
        .run("codex:legacy", JSON.stringify(["codex", "legacy", [
          { backend: "acp%3agrok", monitorThreadId: "card:" + active },
          { backend: "acp:grok", monitorThreadId: "legacy:" + active },
          null,
          { backend: "acp:grok", monitorThreadId: "after-malformed" },
        ]]));
      for (let id = 0; id < 2; id++) {
        put.run("acp%3Agrok:card:" + id, JSON.stringify({ backend: "acp:grok", threadId: "card:" + id,
          ...(grouped && id === active ? { handoffOrigin: { groupingMode: "subthread" } } : {}),
        }));
      }
    };
    const check = (active: number, grouped: boolean) => {
      const visible = threads.filter(({ id }) => id !== "legacy:" + active && (grouped || id !== "card:" + active));
      expect(visibleThreads(store, threads)).toEqual(visible.map(({ id }) => id));
      expect(store.readManagedSubAgentThreadKeys().has("acp%3agrok:card:" + active)).toBe(!grouped);
    };
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (alternate, grouped) => {
      const active = Number(alternate);
      writer.transaction(() => write(writer, active, grouped))();
      check(active, grouped);
      check(active, grouped);
      expect(() => state.raw.transaction(() => {
        write(state.raw, 1 - active, !grouped);
        check(1 - active, !grouped);
        expect(() => state.raw.transaction(() => {
          write(state.raw, active, !grouped);
          check(active, !grouped);
          throw new Error("rollback savepoint");
        })()).toThrow("rollback savepoint");
        check(1 - active, !grouped);
        throw new Error("rollback transaction");
      })()).toThrow("rollback transaction");
      check(active, grouped);
    }), { numRuns: 25 });
  } finally {
    writer.close();
    state.close();
    removeTempStateDbDir(temp.tempDir);
  }
});

it("builds directory membership without rescanning the keys already collected", () => {
  const state = StateDb.open(":memory:");
  try {
    const store = new SqliteOverlayStore(state);
    fc.assert(fc.property(fc.integer({ min: 2, max: 150 }), fc.boolean(), (count, linked) => {
      const threads = Array.from({ length: count }, (_, i) => ({
        ...provider("directory-" + i), createdAt: count - i,
        linkedDirectories: linked ? [{ id: "project", kind: "local" as const, label: "Project", path: "/fixtures/project" }] : [],
      }));
      threads.push(threads[0]!);
      const includes = Array.prototype.includes;
      let scannedEntries = 0;
      const spy = vi.spyOn(Array.prototype, "includes").mockImplementation(function (
        this: unknown[], search: unknown, fromIndex?: number,
      ) {
        if (typeof search === "string" && search.startsWith("codex:directory-")) scannedEntries += this.length;
        return includes.call(this, search, fromIndex);
      });
      let result;
      try {
        result = store.readNavigationQueryIndex({ backend: "all", threads });
      } finally {
        spy.mockRestore();
      }
      expect(result.directories[0]?.threadKeys).toEqual(threads.slice(0, count).map(({ id }) => "codex:" + id));
      expect(scannedEntries).toBe(0);
    }), { numRuns: 25, examples: [[2, false], [2, true]] });
  } finally {
    state.close();
  }
});
