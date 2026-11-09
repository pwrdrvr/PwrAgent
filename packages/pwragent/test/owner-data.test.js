import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { setup } from "./helpers.js";

test("the production daemon atomically adopts legacy threads/jobs and never replays uncertain acceptance", async t => {
  let originalThreads;
  let originalJob;
  const h = await setup(t, { beforeStart({ directory, workspace, home }) {
    mkdirSync(path.join(directory, "jobs"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, "identity.json"), JSON.stringify({ version: 1, workspace, codexHome: home }));
    originalThreads = JSON.stringify({ version: 1, threads: [{ id: "legacy-thread", title: "Retained owner title", titleSource: "explicit",
      createdAt: 1, sandbox: "read-only", pinnedRank: "a0", seenAt: 20, seenUpdatedAt: 10,
      parentThreadId: "retained-parent", parentThreadBackend: "codex", messagingFileTools: true }] });
    originalJob = JSON.stringify({ version: 1, id: "uncertain", fingerprint: "retained-fingerprint", status: "running",
      threadId: "legacy-thread", turnId: "legacy-turn", createdAt: "2026-01-01T00:00:00Z" });
    writeFileSync(path.join(directory, "threads.json"), originalThreads);
    writeFileSync(path.join(directory, "jobs/uncertain.json"), originalJob);
    writeFileSync(path.join(directory, "private-ledger.json"), "private untouched bytes");
  } });
  assert.equal((await h.rpc("show", { id: "uncertain" })).status, "unknown");
  assert.equal((await h.rpc("show", { id: "uncertain" })).fingerprint, "retained-fingerprint");
  assert.equal(h.calls().filter(call => call.method === "turn/start").length, 0);
  assert.equal(existsSync(path.join(h.directory, "threads.json")), false);
  assert.equal(existsSync(path.join(h.directory, "jobs/uncertain.json")), false);
  assert.equal(readFileSync(path.join(h.directory, "legacy-owner-backup-v1/threads.json"), "utf8"), originalThreads);
  assert.equal(readFileSync(path.join(h.directory, "legacy-owner-backup-v1/jobs/uncertain.json"), "utf8"), originalJob);
  assert.equal(readFileSync(path.join(h.directory, "private-ledger.json"), "utf8"), "private untouched bytes");
  const db = new Database(path.join(path.dirname(h.directory), "state.db"));
  try {
    const record = JSON.parse(db.prepare("SELECT payload FROM threads WHERE json_extract(payload, '$.threadId') = ?").get("legacy-thread").payload);
    assert.equal(record.title, "Retained owner title");
    assert.equal(record.pinnedRank, "a0");
    assert.equal(record.lastSeenUpdatedAt, 10);
    assert.equal(record.parentThreadId, "retained-parent");
    // A later SQLite edit must survive restart instead of being reimported.
    db.prepare("UPDATE threads SET payload = json_set(payload, '$.pinnedRank', ?) WHERE json_extract(payload, '$.threadId') = ?").run("b0", "legacy-thread");
    await h.stop(h.daemon);
    await h.start();
    assert.equal((await h.rpc("show", { id: "uncertain" })).status, "unknown");
    assert.equal(h.calls().filter(call => call.method === "turn/start").length, 0);
    assert.equal(JSON.parse(db.prepare("SELECT payload FROM threads WHERE json_extract(payload, '$.threadId') = ?").get("legacy-thread").payload).pinnedRank, "b0");
  } finally { db.close(); }
});
