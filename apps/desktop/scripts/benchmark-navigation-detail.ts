import { mkdtempSync, rmSync, statSync } from "node:fs";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";
import { NAVIGATION_BACKEND_METADATA_SCHEMA } from "../src/main/state/navigation-backend-metadata";
import type { StateDb } from "../src/main/state/state-db";

// Run only against a private, consistent SQLite backup under this checkout's
// .local directory. Neither the snapshot nor the operator's profile is opened
// for writing. The experiment copy is disposable; output contains only counts.
const [snapshotPath, baselinePath] = process.argv.slice(2);
if (!snapshotPath || !baselinePath) throw new Error("Pass private snapshot and git-exported baseline module paths");
const localRoot = path.resolve(".local") + path.sep;
if (!path.resolve(snapshotPath).startsWith(localRoot)) throw new Error("Snapshot must be under apps/desktop/.local");
const { SqliteOverlayStore: BaselineStore } = await import(pathToFileURL(path.resolve(baselinePath)).href) as {
  SqliteOverlayStore: typeof SqliteOverlayStore;
};
const temp = mkdtempSync(path.join(os.tmpdir(), "navigation-detail-benchmark-"));
const file = path.join(temp, "experiment.db");
const source = new Database(path.resolve(snapshotPath), { readonly: true, fileMustExist: true });
try { await source.backup(file); } finally { source.close(); }
const raw = new Database(file);
try {
  raw.pragma("journal_mode = WAL");
  raw.pragma("wal_autocheckpoint = 0");
  raw.pragma("wal_checkpoint(TRUNCATE)");
  const start = performance.now();
  raw.transaction(() => raw.exec(NAVIGATION_BACKEND_METADATA_SCHEMA)).immediate();
  const migration = { ms: performance.now() - start, walBytes: statSync(file + "-wal").size,
    indexBytes: raw.prepare("SELECT sum(pgsize) AS size FROM dbstat WHERE name = ?").get("idx_backends_navigation_metadata") };
  const db = { raw } as StateDb;
  const backendRows = raw.prepare("SELECT scope, length(payload) AS bytes FROM backends ORDER BY bytes DESC").all() as { scope: string; bytes: number }[];
  async function measure(make: () => Promise<unknown> | unknown) {
    const timings: number[] = [];
    for (let n = 0; n < 25; n++) {
      const t = performance.now(); await make();
      if (n >= 5) timings.push(performance.now() - t);
    }
    timings.sort((a, b) => a - b);
    return { medianMs: timings[10], p95Ms: timings[18] };
  }
  function reads(make: () => Promise<unknown> | unknown) {
    const prepare = raw.prepare;
    let queries = 0, rows = 0, textBytes = 0;
    raw.prepare = function(sql: string) {
      const stmt = prepare.call(raw, sql) as Database.Statement<unknown[], Record<string, unknown>>;
      const record = (records: Record<string, unknown>[]) => {
        queries += 1;
        rows += records.length;
        for (const row of records) {
          for (const value of Object.values(row)) {
            if (typeof value === "string") textBytes += Buffer.byteLength(value);
          }
        }
      };
      const get = stmt.get.bind(stmt);
      stmt.get = (...args: unknown[]) => {
        const row = get(...args);
        record(row ? [row] : []);
        return row;
      };
      const all = stmt.all.bind(stmt);
      stmt.all = (...args: unknown[]) => {
        const result = all(...args);
        record(result);
        return result;
      };
      return stmt;
    } as typeof prepare;
    return Promise.resolve(make()).then(() => ({ queries, rows, textBytes })).finally(() => { raw.prepare = prepare; });
  }
  const backend = backendRows[0];
  if (!backend) throw new Error("Snapshot contains no backend metadata");
  const oldMetadata = () => new BaselineStore(db)["getBackend"](backend.scope);
  const newMetadata = () => new SqliteOverlayStore(db)["getBackend"](backend.scope);
  const candidate = raw.prepare("SELECT payload FROM threads WHERE json_valid(payload) AND json_extract(payload, '$.backend') = 'codex' ORDER BY length(payload) ASC LIMIT 1").get() as { payload: string };
  const overlay = JSON.parse(candidate.payload);
  const thread = { id: overlay.threadId, source: "codex" as const, title: "Private benchmark", titleSource: "explicit" as const, linkedDirectories: [] };
  const oldDetail = () => new BaselineStore(db).reconcileNavigationSnapshot({ backend: thread.source, fetchedAt: 1, partial: true, threads: [thread] });
  const newDetail = () => new SqliteOverlayStore(db).projectNavigationThreadDetail({ thread });
  assert.equal(isDeepStrictEqual(newMetadata()?.knownThreadKeys, oldMetadata()?.knownThreadKeys), true, "Known keys must match");
  assert.equal(Boolean(newMetadata()?.lastSnapshotHash), Boolean(oldMetadata()?.lastSnapshotHash));
  assert.equal(isDeepStrictEqual(await newDetail(), (await oldDetail()).threads[0]), true, "Detail must match");
  console.log(JSON.stringify({ migration, largestBackendBytes: backend.bytes,
    metadata: { before: { ...await measure(oldMetadata), ...await reads(oldMetadata) }, after: { ...await measure(newMetadata), ...await reads(newMetadata) } },
    detail: { before: { ...await measure(oldDetail), ...await reads(oldDetail) }, after: { ...await measure(newDetail), ...await reads(newDetail) } },
  }, null, 2));
} finally { raw.close(); rmSync(temp, { recursive: true, force: true }); }
