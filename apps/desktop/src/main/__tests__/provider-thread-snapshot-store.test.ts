import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderThreadSnapshotStore } from "../app-server/provider-thread-snapshot-store";
import { StateDb } from "../state/state-db";
import {
  measureSqliteWrites,
  resetSqliteWriteMetrics,
  SQLITE_WRITE_METRICS_ENV,
} from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("ProviderThreadSnapshotStore", () => {
  it("round trips secret-free provider thread summaries", () => {
    const { db, store } = createStore();
    store.replace({
      backend: "codex",
      observedAt: 42,
      threads: [
        {
          id: "thread-1",
          source: "codex",
          title: "Durable startup thread",
          titleSource: "explicit",
          linkedDirectories: [],
          updatedAt: 41,
        },
      ],
    });

    expect(store.list()).toEqual([
      {
        backend: "codex",
        observedAt: 42,
        threads: [
          expect.objectContaining({
            id: "thread-1",
            title: "Durable startup thread",
          }),
        ],
      },
    ]);
    const payload = db.raw
      .prepare("SELECT payload FROM provider_thread_snapshots WHERE backend = ?")
      .pluck()
      .get("codex") as string;
    expect(payload).not.toContain("transcript");
    expect(payload).not.toContain("secret");
  });

  it("ignores incompatible and malformed durable rows", () => {
    const { db, store } = createStore();
    db.raw.prepare(
      `INSERT INTO provider_thread_snapshots(
         backend, schema_version, observed_at, payload
       ) VALUES (?, ?, ?, ?)`,
    ).run("codex", 999, 1, "[]");
    db.raw.prepare(
      `INSERT INTO provider_thread_snapshots(
         backend, schema_version, observed_at, payload
       ) VALUES (?, ?, ?, ?)`,
    ).run("acp:grok", 1, 1, "not-json");

    expect(store.list()).toEqual([]);
  });
});

describe("ProviderThreadSnapshotStore write cost", () => {
  it("writes one row per successful provider list boundary", async () => {
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-thread-budget-"));
    const db = StateDb.open(path.join(root, "state.db"));
    const store = new ProviderThreadSnapshotStore(db);
    try {
      resetSqliteWriteMetrics();
      const { writes } = await measureSqliteWrites(async () => {
        store.replace({
          backend: "codex",
          observedAt: 42,
          threads: [],
        });
      });
      expectSqliteWriteBudget({
        note:
          "one secret-free provider thread projection per successful full "
          + "provider list, never per thread",
        scenario: "provider-thread-snapshot-refresh",
        writes,
      });
    } finally {
      db.close();
      delete process.env[SQLITE_WRITE_METRICS_ENV];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createStore(): {
  db: StateDb;
  store: ProviderThreadSnapshotStore;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-thread-snapshot-"));
  const db = StateDb.open(path.join(root, "state.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    store: new ProviderThreadSnapshotStore(db),
  };
}
