import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { wal } from "./lab.mjs";
const require = createRequire(import.meta.url);
const Database = require("../../apps/desktop/node_modules/better-sqlite3");
const budgets = JSON.parse(fs.readFileSync(new URL("./write-budgets.json", import.meta.url)));

test("durable progress charges one page in the existing batch, never a heartbeat", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-retention-budget-"));
  const file = path.join(root, "synthetic.db");
  const d = new Database(file);
  try {
    d.pragma("page_size=4096");
    d.pragma("journal_mode=WAL");
    d.pragma("wal_autocheckpoint=0");
    d.exec("CREATE TABLE progress(id INTEGER PRIMARY KEY, completed INTEGER); INSERT INTO progress VALUES (1,0)");
    d.pragma("wal_checkpoint(TRUNCATE)");
    const initial = wal(file + "-wal");
    assert.equal(initial.frames, budgets["cancelled-before-first-batch"].frames);
    assert.equal(initial.commits, budgets["cancelled-before-first-batch"].commits);
    d.exec("BEGIN; UPDATE progress SET completed=999; ROLLBACK");
    assert.equal(d.prepare("SELECT completed FROM progress").get().completed, 0);
    assert.equal(wal(file + "-wal").commits, 0);
    for (let i = 0; i < 64; i++) d.exec("BEGIN IMMEDIATE; UPDATE progress SET completed=completed+1; COMMIT");
    const measured = wal(file + "-wal");
    const budget = budgets["progress-only-64-batches"];
    assert.equal(measured.commits, budget.commits);
    assert.equal(measured.frames, budget.frames);
    assert.equal(measured.unique, budget.uniquePages);
    assert.equal(measured.bytes, budget.walBytes);
    assert.equal(measured.repeated, 63);
    assert.equal(d.prepare("SELECT completed FROM progress").get().completed, 64);
  } finally { d.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("WAL accounting rejects partial frames rather than treating bytes as commits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-wal-test-"));
  try {
    const file = path.join(root, "bad-wal");
    const bytes = Buffer.alloc(33); bytes.writeUInt32BE(4096, 8);
    fs.writeFileSync(file, bytes);
    assert.throws(() => wal(file), /Incomplete WAL frame/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
