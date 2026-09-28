// Offline retained-data copy experiment. Never a production cutover utility.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
const require = createRequire(import.meta.url);
const Database = require("../../apps/desktop/node_modules/better-sqlite3");
const root = path.resolve(process.argv[2] || ".local/archive-retention");
if (!root.startsWith(path.resolve(".local") + path.sep)) throw new Error("Private .local directory required");
process.umask(0o077);
const target = path.join(root, "rebuilt.db");
if (fs.existsSync(target)) throw new Error("Refusing to overwrite rebuild");
const src = new Database(path.join(root, "prepared.db"), { readonly: true });
const dst = new Database(target);
dst.pragma("auto_vacuum=INCREMENTAL");
dst.pragma("journal_mode=WAL");
dst.pragma("synchronous=NORMAL");
dst.pragma("wal_autocheckpoint=0");
const q = (s) => `"${s.replaceAll('"', '""')}"`;
const candidates = JSON.parse(fs.readFileSync(path.join(root, "candidates.json")));
dst.exec("CREATE TEMP TABLE eligible(id TEXT PRIMARY KEY)");
dst.transaction(() => { const stmt = dst.prepare("INSERT INTO eligible VALUES (?)"); for (const r of candidates) stmt.run(r.id); })();
dst.prepare("ATTACH DATABASE ? AS source").run(path.join(root, "prepared.db"));
const schema = src.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
const shadows = new Set(src.pragma("table_list").filter((r) => r.type === "shadow").map((r) => r.name));
const tables = schema.filter((r) => r.type === "table" && !shadows.has(r.name));
// Hypothetical explicit approval to discard tool-detail history. All identity,
// accounting, retention generations, references and user configuration survive.
const detail = new Set(["thread_tool_invocations", "thread_tool_invocation_alerts", "thread_tool_analysis",
  "token_miser_objects", "token_miser_observations"]);
const where = (t) => !detail.has(t) ? "" : t.startsWith("token_miser_")
  ? " WHERE thread_id NOT IN (SELECT id FROM eligible)"
  : " WHERE backend != 'codex' OR thread_id NOT IN (SELECT id FROM eligible)";
const frames = () => {
  const file = target + "-wal";
  if (!fs.existsSync(file) || fs.statSync(file).size < 32) return { frames: 0, unique: 0, commits: 0, bytes: 0 };
  const b = fs.readFileSync(file); const pages = new Set(); let commits = 0;
  for (let i = 32; i < b.length; i += 4120) { pages.add(b.readUInt32BE(i)); commits += Number(b.readUInt32BE(i + 4) !== 0); }
  return { frames: (b.length - 32) / 4120, unique: pages.size, commits, bytes: b.length };
};
const phases = [];
function phase(name, fn) {
  const checkpointStart = performance.now();
  dst.pragma("main.wal_checkpoint(TRUNCATE)");
  const checkpointBeforeMs = performance.now() - checkpointStart;
  const start = performance.now(); fn();
  phases.push({ name, ms: performance.now() - start, checkpointBeforeMs, wal: frames() });
}
phase("schema", () => dst.transaction(() => { for (const r of tables) dst.exec(r.sql); })());
const counts = [];
phase("retainedRows", () => dst.transaction(() => {
  for (const { name } of tables) {
    const cols = src.prepare(`PRAGMA table_info(${q(name)})`).all().map((r) => q(r.name)).join(",");
    const result = dst.prepare(`INSERT INTO ${q(name)}(rowid,${cols}) SELECT rowid,${cols} FROM source.${q(name)}${where(name)}`).run();
    counts.push({ table: name, kept: result.changes, original: src.prepare(`SELECT count(*) n FROM ${q(name)}`).get().n });
  }
  if (src.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
    dst.exec("DELETE FROM sqlite_sequence; INSERT INTO sqlite_sequence SELECT * FROM source.sqlite_sequence");
  }
})());
phase("indexesViewsTriggers", () => dst.transaction(() => {
  for (const type of ["index", "view", "trigger"]) for (const r of schema.filter((r) => r.type === type && !shadows.has(r.tbl_name))) dst.exec(r.sql);
  dst.pragma(`user_version=${src.pragma("user_version", { simple: true })}`);
})());
const validationStart = performance.now();
const integrity = dst.pragma("integrity_check", { simple: true });
const foreignKeyErrors = dst.pragma("foreign_key_check").length;
const hash = (iter) => { const h = createHash("sha256"); for (const row of iter) h.update(JSON.stringify(row) + "\n"); return h.digest("hex"); };
let matched = 0;
for (const { name } of tables) {
  const original = hash(dst.prepare(`SELECT rowid,* FROM source.${q(name)}${where(name)} ORDER BY rowid`).iterate());
  const rebuilt = hash(dst.prepare(`SELECT rowid,* FROM ${q(name)} ORDER BY rowid`).iterate());
  if (original !== rebuilt) throw new Error(`Retained-data mismatch: ${name}`);
  matched++;
}
const validationMs = performance.now() - validationStart;
phase("checkpoint", () => dst.pragma("main.wal_checkpoint(TRUNCATE)"));
const report = { policy: "explicit approved tool-detail removal only; all metadata and accounting retained", phases,
  integrity, foreignKeyErrors, matchedTables: matched, validationMs, counts,
  sourceBytes: fs.statSync(path.join(root, "prepared.db")).size, rebuiltBytes: fs.statSync(target).size };
fs.writeFileSync(path.join(root, "rebuild.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, counts: undefined }));
dst.close(); src.close();
