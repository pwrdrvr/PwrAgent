// Experimental, copy-only harness. Never pass the live profile directory.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);
const Database = require("../../apps/desktop/node_modules/better-sqlite3");
const root = path.resolve(process.argv[2] || ".local/archive-retention");
if (!root.startsWith(path.resolve(".local") + path.sep)) throw new Error("Lab must be inside ignored .local/");
if (isMainThread) process.umask(0o077);
const baseline = path.join(root, "baseline.db");
const prepared = path.join(root, "prepared.db");
const out = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const now = () => performance.now();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const percentile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)] : 0;
const dist = (values) => ({ n: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(0, ...values) });

export function wal(file, from = 0) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 32) return { frames: 0, unique: 0, repeated: 0, commits: 0, bytes: 0 };
  const b = fs.readFileSync(file);
  const size = b.readUInt32BE(8);
  const stride = size + 24;
  if ((b.length - 32) % stride) throw new Error("Incomplete WAL frame");
  const pages = new Set();
  let commits = 0;
  let frames = 0;
  for (let i = 32 + from * stride; i < b.length; i += stride) {
    pages.add(b.readUInt32BE(i));
    commits += Number(b.readUInt32BE(i + 4) !== 0);
    frames++;
  }
  return { frames, unique: pages.size, repeated: frames - pages.size, commits, bytes: frames * stride + (from ? 0 : 32) };
}

function open(file, options = {}) {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("synchronous = NORMAL");
  d.pragma("foreign_keys = ON");
  d.pragma("wal_autocheckpoint = 0");
  d.pragma("busy_timeout = 50");
  d.pragma(`cache_size = -${options.cacheKiB ?? 16000}`);
  d.pragma(`secure_delete = ${options.secureDelete ? "ON" : "OFF"}`);
  return d;
}

function copy(name) {
  const file = path.join(root, `${name}.db`);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  fs.copyFileSync(prepared, file);
  return file;
}

const historyTables = ["thread_usage_boundaries", "thread_usage_lines", "thread_usage_turns",
  "thread_tool_invocation_alerts", "thread_tool_invocations", "thread_tool_analysis",
  "thread_compactions", "thread_message_origins", "thread_pricing_summaries"];

function operations(db, mode, indexed = false) {
  // Separate FTS and documents: this schema has no FTS delete trigger.
  const specs = [["thread_search_fts", "backend = 'codex' AND thread_id = ?", "id"],
    ["thread_search_documents", "backend = 'codex' AND thread_id = ?", "id"]];
  if (indexed) {
    specs[0] = ["thread_search_fts", "rowid = ?", "ftsRowid"];
    specs[1] = ["thread_search_documents", "identity_key = ?", "searchKey"];
  }
  if (mode === "tool-detail") specs.length = 0;
  if (mode !== "cache") {
    const selectedTables = mode === "tool-detail"
      ? ["thread_tool_invocation_alerts", "thread_tool_invocations", "thread_tool_analysis"] : historyTables;
    for (const t of selectedTables) {
      if (indexed && db.prepare(`PRAGMA table_info(${quote(t)})`).all().some((c) => c.name === "provider")) {
        for (const { provider } of db.prepare(`SELECT DISTINCT provider FROM ${quote(t)}`).all()) {
          specs.push([t, `provider = '${provider.replaceAll("'", "''")}' AND backend = 'codex' AND thread_id = ?`, "id"]);
        }
      } else specs.push([t, "backend = 'codex' AND thread_id = ?", "id"]);
    }
    for (const t of ["token_miser_objects", "token_miser_observations"]) specs.push([t, "thread_id = ?", "id"]);
    // Keep retention generations: deleting them can re-admit stale writers.
    if (mode === "owner-history") specs.push(["threads", "thread_id = ?", "key"]);
  }
  return specs.map(([table, where, key]) => ({ table, key, where, stmt: db.prepare(`DELETE FROM ${quote(table)} WHERE ${where}`) }));
}

function removeBatch(db, ops, batch, order) {
  if (order === "thread") {
    for (const c of batch) for (const op of ops) op.stmt.run(c[op.key]);
  } else {
    for (const op of ops) for (const c of batch) op.stmt.run(c[op.key]);
  }
}

async function prepare() {
  if (fs.existsSync(prepared)) throw new Error("Refusing to overwrite prepared baseline; use a new snapshot directory");
  fs.copyFileSync(baseline, prepared);
  const d = open(prepared);
  const version = d.pragma("user_version", { simple: true });
  if (![63, 64].includes(version)) throw new Error("This design harness understands schema 63/64 only");
  const schema = fs.readFileSync("apps/desktop/src/main/state/thread-navigation-relationships.ts", "utf8").split("`;")[0].split("= `")[1];
  const start = now();
  if (version === 63) d.exec(`BEGIN IMMEDIATE; ${schema}; PRAGMA user_version = 64; COMMIT;`);
  const migration = { ms: now() - start, wal: wal(prepared + "-wal"), rows: d.prepare("SELECT count(*) n FROM thread_navigation_relationships").get().n };
  d.pragma("wal_checkpoint(TRUNCATE)");
  const evidence = JSON.parse(fs.readFileSync(path.join(root, "provider-evidence.json")));
  const archived = new Set(evidence.filter((r) => r.archived).map((r) => r.id));
  const active = new Set(evidence.filter((r) => !r.archived).map((r) => r.id));
  const scanStart = now();
  const candidates = d.prepare("SELECT rowid, thread_id key, length(CAST(payload AS BLOB)) overlayBytes, json_extract(payload, '$.threadId') id FROM threads WHERE json_extract(payload, '$.backend') = 'codex'").all()
    .filter((r) => archived.has(r.id) && !active.has(r.id));
  const inventory = [];
  const tables = [...historyTables, "token_miser_objects", "token_miser_observations"];
  for (const c of candidates) c.bytes = c.overlayBytes;
  for (const t of tables) {
    const cols = d.prepare(`PRAGMA table_info(${quote(t)})`).all();
    const expr = cols.map((c) => `coalesce(length(CAST(${quote(c.name)} AS BLOB)),0)`).join("+");
    const hasBackend = cols.some((c) => c.name === "backend");
    const rows = d.prepare(`SELECT thread_id id, count(*) n, sum(${expr}) bytes FROM ${quote(t)} ${hasBackend ? "WHERE backend='codex'" : ""} GROUP BY thread_id`).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const owned = candidates.map((c) => byId.get(c.id)).filter(Boolean);
    for (const c of candidates) c.bytes += byId.get(c.id)?.bytes ?? 0;
    inventory.push({ table: t, rows: owned.reduce((n, r) => n + r.n, 0), logicalBytes: owned.reduce((n, r) => n + r.bytes, 0) });
  }
  out("candidates.json", candidates);
  const report = { migration, sqlite: d.prepare("SELECT sqlite_version() v").get().v,
    pragmas: Object.fromEntries(["page_size", "page_count", "freelist_count", "auto_vacuum", "cache_size", "cache_spill", "secure_delete"].map((p) => [p, d.pragma(p, { simple: true })])),
    candidateCount: candidates.length, discoveryLocalMs: now() - scanStart, inventory,
    logicalBytes: dist(candidates.map((r) => r.bytes)), overlayBytes: dist(candidates.map((r) => r.overlayBytes)),
    top10LogicalBytes: [...candidates].sort((a, b) => b.bytes - a.bytes).slice(0, 10).map((r) => r.bytes),
    integrity: d.pragma("integrity_check", { simple: true }) };
  out("preparation.json", report);
  d.close();
  console.log(JSON.stringify(report));
}

async function probe() {
  const d = open(workerData.file);
  d.pragma("busy_timeout = 1");
  const times = [];
  let busy = 0;
  let stopping = false;
  parentPort.on("message", () => { stopping = true; });
  parentPort.postMessage("ready");
  while (!stopping) {
    const start = now();
    try {
      if (workerData.kind === "writer") d.prepare("INSERT INTO meta(key,value) VALUES ('retention_lab_probe',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(start));
      else d.prepare("SELECT count(*) FROM threads").get();
      times.push(now() - start);
    } catch (error) {
      if (!error.code?.startsWith("SQLITE_BUSY")) throw error;
      busy++;
    }
    await delay(2);
  }
  d.close();
  parentPort.postMessage({ kind: workerData.kind, latencyMs: dist(times), busy });
  parentPort.close();
}

async function scenario(options) {
  const name = Object.values(options).join("-");
  const file = copy("run");
  const d = open(file, options);
  let candidates = JSON.parse(fs.readFileSync(path.join(root, "candidates.json")));
  if (options.order === "rowid") candidates.sort((a, b) => a.rowid - b.rowid);
  else if (options.order === "largest") candidates.sort((a, b) => b.bytes - a.bytes);
  else candidates.sort((a, b) => a.id.localeCompare(b.id));
  if (options.giant) candidates = [...candidates].sort((a, b) => b.bytes - a.bytes).slice(0, 1);
  const lookupStart = now();
  const fts = new Map(d.prepare("SELECT thread_id, rowid FROM thread_search_fts WHERE backend='codex'").all().map((r) => [r.thread_id, r.rowid]));
  const docs = new Map(d.prepare("SELECT thread_id, identity_key FROM thread_search_documents WHERE backend='codex'").all().map((r) => [r.thread_id, r.identity_key]));
  for (const c of candidates) { c.ftsRowid = fts.get(c.id) ?? -1; c.searchKey = docs.get(c.id) ?? ""; }
  const ops = operations(d, options.mode, options.indexed);
  const lookupMs = now() - lookupStart;
  let pinned;
  if (options.pinnedReader) {
    pinned = new Database(file, { readonly: true });
    pinned.exec("BEGIN");
    pinned.prepare("SELECT count(*) FROM threads").get();
  }
  const plans = ops.map((o) => ({ table: o.table, plan: d.prepare(`EXPLAIN QUERY PLAN DELETE FROM ${quote(o.table)} WHERE ${o.where}`).all(candidates[0][o.key]).map((p) => p.detail) }));
  const workers = [];
  if (options.concurrent) {
    for (const kind of ["reader", "writer"]) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { kind, file }, argv: [root] });
      await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
      workers.push(worker);
    }
  }
  const locks = [];
  const waits = [];
  const batchFrames = [];
  let lastFrames = 0;
  const start = now();
  for (let i = 0; i < candidates.length; i += options.batch) {
    const batch = candidates.slice(i, i + options.batch);
    const waitStart = now();
    d.exec("BEGIN IMMEDIATE");
    const lockStart = now();
    waits.push(lockStart - waitStart);
    removeBatch(d, ops, batch, options.order);
    d.exec("COMMIT");
    locks.push(now() - lockStart);
    const currentFrames = Math.max(0, (fs.statSync(file + "-wal").size - 32) / 4120);
    batchFrames.push(currentFrames - lastFrames);
    lastFrames = currentFrames;
    if (options.yieldMs) await delay(options.yieldMs);
  }
  const elapsedMs = now() - start;
  const probes = [];
  for (const worker of workers) {
    const done = new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    worker.postMessage("stop");
    probes.push(await done);
  }
  const measuredWal = wal(file + "-wal");
  const pages = d.pragma("page_count", { simple: true });
  const free = d.pragma("freelist_count", { simple: true });
  const checkpointStart = now();
  const checkpoint = d.pragma("wal_checkpoint(TRUNCATE)");
  const checkpointMs = now() - checkpointStart;
  if (pinned) { pinned.exec("ROLLBACK"); pinned.close(); }
  const releasedCheckpointStart = now();
  const releasedCheckpoint = d.pragma("wal_checkpoint(TRUNCATE)");
  const releasedCheckpointMs = now() - releasedCheckpointStart;
  const integrity = d.pragma("integrity_check", { simple: true });
  const foreignKeyErrors = d.pragma("foreign_key_check").length;
  const result = { name, ...options, threads: candidates.length, elapsedMs, lookupMs, lockMs: dist(locks), waitMs: dist(waits), batchFrames: dist(batchFrames),
    wal: measuredWal, pages, free, checkpointMs, checkpoint, releasedCheckpoint, releasedCheckpointMs, integrity, foreignKeyErrors, probes, plans };
  if (options.reclaim) {
    const t = now();
    d.pragma("incremental_vacuum(256)");
    result.incremental256 = { ms: now() - t, wal: wal(file + "-wal"), free: d.pragma("freelist_count", { simple: true }) };
    d.pragma("wal_checkpoint(TRUNCATE)");
    const t2 = now();
    d.pragma("incremental_vacuum");
    result.incrementalAll = { ms: now() - t2, wal: wal(file + "-wal"), pages: d.pragma("page_count", { simple: true }) };
    d.pragma("wal_checkpoint(TRUNCATE)");
    const t3 = now();
    d.exec("VACUUM");
    result.vacuum = { ms: now() - t3, wal: wal(file + "-wal"), pages: d.pragma("page_count", { simple: true }) };
  }
  d.close();
  fs.appendFileSync(path.join(root, "results.jsonl"), JSON.stringify(result) + "\n");
  console.log(JSON.stringify({ name, elapsedMs, lockMs: result.lockMs, walMiB: measuredWal.bytes / 1048576, freeMiB: free * 4096 / 1048576, probes }));
}

async function recovery() {
  const candidates = JSON.parse(fs.readFileSync(path.join(root, "candidates.json")));
  const file = copy("recovery");
  let d = open(file);
  d.exec("CREATE TABLE lab_progress(id INTEGER PRIMARY KEY, completed INTEGER NOT NULL); INSERT INTO lab_progress VALUES (1,0)");
  const tables = ["threads", ...historyTables, "token_miser_objects", "token_miser_observations"];
  const counts = (db) => tables.map((t) => db.prepare(`SELECT count(*) n FROM ${quote(t)}`).get().n);
  const before = counts(d);
  d.close();
  const trials = [];
  for (const stage of ["before", "after"]) {
    const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname, root, "crash-child", stage], { stdio: "ignore" });
    const crashWal = wal(file + "-wal");
    const start = now(); d = open(file);
    const completed = d.prepare("SELECT completed FROM lab_progress WHERE id=1").get().completed;
    const integrity = d.pragma("integrity_check", { simple: true });
    const restored = JSON.stringify(counts(d)) === JSON.stringify(before);
    if (result.signal !== "SIGKILL" || integrity !== "ok" || completed !== (stage === "before" ? 0 : 10) || (stage === "before" && !restored)) throw new Error("Crash recovery invariant failed");
    trials.push({ stage, signal: result.signal, crashWal, completed, allOwnedCountsRestored: restored, integrity, recoveryAndIntegrityMs: now() - start });
    d.close();
  }
  d = open(file);
  const ops = operations(d, "owner-history");
  const start = now();
  d.exec("BEGIN IMMEDIATE");
  const completed = d.prepare("SELECT completed FROM lab_progress WHERE id=1").get().completed;
  removeBatch(d, ops, candidates.slice(completed, completed + 10), "table");
  d.prepare("UPDATE lab_progress SET completed=? WHERE id=1").run(completed + 10);
  d.exec("COMMIT");
  const resumedMs = now() - start;
  // Cancellation at this boundary does not open another write transaction.
  const cancelledAt = d.prepare("SELECT completed FROM lab_progress WHERE id=1").get().completed;
  if (cancelledAt !== 20) throw new Error("Resume skipped or repeated a batch");
  const foreignKeyErrors = d.pragma("foreign_key_check").length;
  d.close();
  const report = { trials, resumedMs, cancelledAt, foreignKeyErrors };
  out("recovery.json", report); console.log(JSON.stringify(report));
}

async function sliced() {
  const file = copy("sliced");
  const d = open(file);
  const candidate = JSON.parse(fs.readFileSync(path.join(root, "candidates.json"))).sort((a, b) => b.bytes - a.bytes)[0];
  candidate.ftsRowid = d.prepare("SELECT rowid FROM thread_search_fts WHERE backend='codex' AND thread_id=?").get(candidate.id)?.rowid ?? -1;
  candidate.searchKey = d.prepare("SELECT identity_key FROM thread_search_documents WHERE backend='codex' AND thread_id=?").get(candidate.id)?.identity_key ?? "";
  d.exec("CREATE TABLE lab_progress(id INTEGER PRIMARY KEY, deleted INTEGER NOT NULL); INSERT INTO lab_progress VALUES (1,0)");
  d.pragma("wal_checkpoint(TRUNCATE)");
  const marker = d.prepare("UPDATE lab_progress SET deleted=deleted+? WHERE id=1");
  const locks = []; const batchFrames = []; let priorFrames = 0; let chunks = 0;
  const start = now();
  for (const op of operations(d, "owner-history", true)) {
    const stmt = d.prepare(`DELETE FROM ${quote(op.table)} WHERE rowid IN (SELECT rowid FROM ${quote(op.table)} WHERE ${op.where} LIMIT 128)`);
    while (true) {
      d.exec("BEGIN IMMEDIATE"); const locked = now();
      const { changes } = stmt.run(candidate[op.key]);
      if (!changes) { d.exec("ROLLBACK"); break; }
      marker.run(changes); d.exec("COMMIT");
      locks.push(now() - locked); chunks++;
      const frames = Math.max(0, (fs.statSync(file + "-wal").size - 32) / 4120);
      batchFrames.push(frames - priorFrames); priorFrames = frames;
      await delay(5);
    }
  }
  const report = { rowLimit: 128, yieldMs: 5, chunks, elapsedMs: now() - start,
    lockMs: dist(locks), batchFrames: dist(batchFrames), wal: wal(file + "-wal"),
    integrity: d.pragma("integrity_check", { simple: true }), foreignKeyErrors: d.pragma("foreign_key_check").length };
  out("sliced.json", report); console.log(JSON.stringify(report)); d.close();
}

function crashChild(stage) {
  const d = open(path.join(root, "recovery.db"), { cacheKiB: 32 });
  const candidates = JSON.parse(fs.readFileSync(path.join(root, "candidates.json"))).slice(0, 10);
  const ops = operations(d, "owner-history");
  d.exec("BEGIN IMMEDIATE");
  removeBatch(d, ops, candidates, "table");
  d.exec("UPDATE lab_progress SET completed=10 WHERE id=1");
  if (stage === "after") d.exec("COMMIT");
  process.kill(process.pid, "SIGKILL");
}

if (!isMainThread) await probe();
else if (process.argv[3] === "prepare") await prepare();
else if (process.argv[3] === "one") await scenario(JSON.parse(process.argv[4]));
else if (process.argv[3] === "recovery") await recovery();
else if (process.argv[3] === "sliced") await sliced();
else if (process.argv[3] === "crash-child") crashChild(process.argv[4]);
else if (process.argv[3] === "matrix") {
  for (const batch of [1, 5, 10, 20]) for (const order of ["thread", "table", "rowid"]) for (const yieldMs of [0, 5]) {
    await scenario({ mode: "owner-history", batch, order, yieldMs });
  }
}
else if (process.argv[3] === "extras") {
  for (const batch of [1, 5, 10, 20]) await scenario({ mode: "owner-history", batch, order: "table", yieldMs: 5, indexed: true });
  for (const batch of [1, 5, 10, 20]) for (const yieldMs of [0, 5]) await scenario({ mode: "owner-history", batch, order: "table", yieldMs, indexed: true, concurrent: true });
  for (const mode of ["cache", "retain-overlay"]) await scenario({ mode, batch: 10, order: "table", yieldMs: 5, indexed: true });
  for (const secureDelete of [false, true]) for (const cacheKiB of [32, 16000]) await scenario({ mode: "owner-history", batch: 1, order: "table", yieldMs: 0, indexed: true, giant: true, secureDelete, cacheKiB });
  await scenario({ mode: "owner-history", batch: 20, order: "table", yieldMs: 0, indexed: true, cacheKiB: 32 });
}
else if (process.argv[3] === "repeats") {
  for (const repetition of [2, 3]) for (const batch of [5, 10, 20]) await scenario({ mode: "owner-history", batch, order: "table", yieldMs: 5, indexed: true, repetition });
}
