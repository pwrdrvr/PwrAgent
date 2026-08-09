#!/usr/bin/env node
/**
 * Rank whatever produced the most sqlite write volume in a run.
 *
 * Reads the JSONL that `PWRAGENT_DEV_SQLITE_WRITE_METRICS_FILE` collected —
 * one line per vitest file, or per app process in an E2E run — and prints the
 * heaviest writers. Commits lead the ranking because write amplification
 * tracks commits, not statements: every implicit transaction flushes its dirty
 * pages plus every index they moved.
 *
 * Usage:
 *   node scripts/report-sqlite-writes.mjs <metrics.jsonl> [--top N]
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const topIndex = args.indexOf("--top");
const top = topIndex >= 0 ? Number(args[topIndex + 1]) : 15;

if (!file) {
  console.error("usage: report-sqlite-writes.mjs <metrics.jsonl> [--top N]");
  process.exit(64);
}

let lines = [];
try {
  lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
} catch {
  console.error(`No metrics were recorded at ${file}.`);
  console.error(
    "Nothing opened a real StateDb, or the run was not started with PWRAGENT_DEV_SQLITE_WRITE_METRICS=1.",
  );
  process.exit(1);
}

const entries = [];
for (const line of lines) {
  try {
    entries.push(JSON.parse(line));
  } catch {
    // A truncated final line from a killed run should not lose the rest.
  }
}

if (entries.length === 0) {
  console.error(`No usable metrics in ${file}.`);
  process.exit(1);
}

entries.sort((left, right) => right.commits - left.commits);

const totals = entries.reduce(
  (sum, entry) => ({
    commits: sum.commits + entry.commits,
    rowsChanged: sum.rowsChanged + entry.rowsChanged,
    statements: sum.statements + entry.statements,
    walBytes: sum.walBytes + entry.walBytes,
  }),
  { commits: 0, rowsChanged: 0, statements: 0, walBytes: 0 },
);

const byTable = new Map();
for (const entry of entries) {
  for (const table of entry.tables) {
    const current = byTable.get(table.table) ?? {
      commits: 0,
      statements: 0,
      table: table.table,
    };
    current.commits += table.commits;
    current.statements += table.statements;
    byTable.set(table.table, current);
  }
}

console.log("");
console.log("sqlite write volume");
console.log("===================");
console.log(
  `${entries.length} source(s) · ${fmt(totals.commits)} commits · `
    + `${fmt(totals.statements)} write statements · ${fmt(totals.rowsChanged)} rows · `
    + `${mb(totals.walBytes)} WAL`,
);
console.log("");
console.log(`Top ${Math.min(top, entries.length)} by commits:`);
for (const entry of entries.slice(0, top)) {
  const hottest = entry.tables[0];
  console.log(
    `  ${pad(fmt(entry.commits), 8)} commits  ${pad(mb(entry.walBytes), 10)}  ${short(entry.label)}`
      + (hottest ? `  [${hottest.table} ${fmt(hottest.commits)}]` : ""),
  );
}

console.log("");
// Statements are shown alongside because a table only ever written inside
// explicit transactions has its commits attributed to the transaction, not to
// any one table — it would otherwise look like it never writes at all.
console.log("Top tables by commits:");
for (const table of [...byTable.values()]
  .sort((left, right) => right.commits - left.commits)
  .slice(0, top)) {
  console.log(
    `  ${pad(fmt(table.commits), 8)} commits  ${pad(fmt(table.statements), 8)} stmts  ${table.table}`,
  );
}
console.log("");

function fmt(value) {
  return value.toLocaleString("en-US");
}

function mb(bytes) {
  if (bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function pad(value, width) {
  return String(value).padStart(width);
}

function short(label) {
  const marker = "/apps/desktop/";
  const index = label.indexOf(marker);
  return index >= 0 ? label.slice(index + marker.length) : label;
}
