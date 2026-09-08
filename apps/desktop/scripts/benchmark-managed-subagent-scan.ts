import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";
import type { StateDb } from "../src/main/state/state-db";

// Supply a git-exported baseline module under apps/desktop/.local so it uses
// this checkout's dependencies. Only synthetic data is opened by this probe.
const baselinePath = process.argv[2];
if (!baselinePath) throw new Error("Pass the baseline overlay-store TypeScript module path");
const { SqliteOverlayStore: BaselineStore } = await import(
  pathToFileURL(path.resolve(baselinePath)).href
) as { SqliteOverlayStore: typeof SqliteOverlayStore };
const tempDir = mkdtempSync(path.join(os.tmpdir(), "managed-subagent-bench-"));
const raw = new Database(path.join(tempDir, "state.db"));
raw.pragma("journal_mode = WAL");
raw.exec(`
  CREATE TABLE threads(thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE backends(scope TEXT PRIMARY KEY, payload TEXT NOT NULL);
`);
const insert = raw.prepare("INSERT INTO threads VALUES (?, ?)");
const history = Array.from({ length: 100 }, (_, index) => ({
  id: `activity-${index}`, createdAt: index, kind: "fixture",
  detail: "Synthetic activity metadata. ".repeat(6),
}));
raw.transaction(() => {
  for (let index = 0; index < 629; index += 1) {
    insert.run(`codex:parent-${index}`, JSON.stringify({
      backend: "codex", threadId: `parent-${index}`, immutableUsageActivities: history,
      subAgents: [{ monitorThreadId: `child-${index}`, backend: "codex", task: "Synthetic worker" }],
    }));
    insert.run(`codex:child-${index}`, JSON.stringify({
      backend: "codex", threadId: `child-${index}`, immutableUsageActivities: history,
      handoffOrigin: { groupingMode: index % 4 === 0 ? "subthread" : "none" },
    }));
  }
  for (let index = 0; index < 3_000; index += 1) {
    insert.run(`codex:ordinary-${index}`, JSON.stringify({
      backend: "codex", threadId: `ordinary-${index}`, immutableUsageActivities: history.slice(0, 10),
    }));
  }
  raw.prepare("INSERT INTO backends VALUES (?, ?)").run("all", JSON.stringify({
    knownThreadKeys: Array.from({ length: 10_000 }, (_, index) => `acp%3Agrok:thread-${index}`),
    lastSnapshotHash: "baseline",
  }));
})();
const stateDb = { raw } as StateDb;
const baseline = new BaselineStore(stateDb);
const current = new SqliteOverlayStore(stateDb);
const oldScan = () => baseline["listManagedSubAgentThreadKeys"]();
const newScan = () => current["listManagedSubAgentThreadKeys"]();
assert.deepEqual(newScan(), oldScan());
assert.deepEqual(current["getBackend"]("all"), baseline["getBackend"]("all"));

function measure(run: () => unknown, before: () => void = () => {}): object {
  const samples: number[] = [];
  for (let index = 0; index < 25; index += 1) {
    before();
    const start = performance.now();
    run();
    const elapsed = performance.now() - start;
    if (index >= 5) samples.push(elapsed);
  }
  samples.sort((left, right) => left - right);
  return { medianMs: samples[10], p95Ms: samples[18] };
}
const invalidate = () => raw.prepare("UPDATE backends SET payload = payload WHERE scope = ?").run("all");

function transferredRows(read: () => unknown): object[] {
  const prepare = raw.prepare;
  const queries: object[] = [];
  raw.prepare = ((sql: string) => {
    const statement = prepare.call(raw, sql) as Database.Statement;
    const all = statement.all.bind(statement);
    statement.all = (...params: unknown[]) => {
      const rows = all(...params) as Record<string, unknown>[];
      queries.push({
        rows: rows.length,
        textBytes: rows.reduce((total, row) => total + Object.values(row).reduce<number>(
          (bytes, value) => bytes + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0,
        ), 0),
      });
      return rows;
    };
    return statement;
  }) as typeof raw.prepare;
  try {
    read();
    return queries;
  } finally {
    raw.prepare = prepare;
  }
}

try {
  const baselineTransferredRows = transferredRows(oldScan);
  invalidate();
  const currentTransferredRows = transferredRows(newScan);
  console.log(JSON.stringify({
    runtime: {
      node: process.versions.node,
      v8: process.versions.v8,
      sqlite: raw.prepare("SELECT sqlite_version()").pluck().get(),
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
    },
    fixture: { parents: 629, children: 629, unrelated: 3_000, knownThreadKeys: 10_000 },
    baselineTransferredRows,
    currentTransferredRows,
    baselineFullHelper: measure(oldScan),
    currentInvalidatedFullHelper: measure(newScan, invalidate),
    currentUnchangedFullHelper: measure(newScan),
    baselineBackend: measure(() => baseline["getBackend"]("all")),
    currentUnchangedBackend: measure(() => current["getBackend"]("all")),
  }, null, 2));
} finally {
  raw.close();
  rmSync(tempDir, { recursive: true, force: true });
}
