import Database from "better-sqlite3";
import { ownerStorage } from "./helpers/owner-storage.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Codex } from "../src/codex.js";
import { JobStore } from "../src/store.js";
import { readMessages } from "../src/wire.js";

test("framing handles split UTF-8 and multiple envelopes, and rejects oversized or partial messages", () => {
  const stream = new PassThrough();
  const received = [];
  const errors = [];
  readMessages(stream, 32, (value) => received.push(value), (error) => errors.push(error));
  const bytes = Buffer.from('{"text":"☃"}\n{"id":2}\n');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  assert.deepEqual(received, [{ text: "☃" }, { id: 2 }]);
  stream.write("x".repeat(33));
  assert.match(errors[0].message, /size limit/);
  stream.destroy();
  const truncated = new EventEmitter();
  readMessages(truncated, 32, () => assert.fail("unexpected message"), (error) => errors.push(error));
  truncated.emit("data", Buffer.from('{"id":'));
  truncated.emit("end");
  assert.match(errors[1].message, /Truncated/);
});

test("registry recovers uncertain work without replay, binds workspace/home and fails closed on corruption", (t) => {
  const local = fileURLToPath(new URL("../../../.local/", import.meta.url));
  mkdirSync(local, { recursive: true });
  const directory = mkdtempSync(path.join(local, "registry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = ownerStorage(t, directory, "/fixture/workspace");
  const { identity, profile } = owner;
  const store = new JobStore(owner.directory, identity, profile);
  store.save({ version: 1, id: "uncertain", status: "running", fingerprint: "fixture", threadId: "thread-fixture" });
  const reopened = new JobStore(owner.directory, identity, profile);
  assert.equal(reopened.get("uncertain").status, "unknown");
  const before = reopened.get("uncertain");
  new JobStore(owner.directory, identity, profile);
  assert.deepEqual(reopened.get("uncertain"), before, "no idle rewrite");
  assert.throws(() => new JobStore(owner.directory, { ...identity, codexHome: "/different" }, profile), /different workspace or Codex home/);
  unlinkSync(path.join(owner.directory, "identity.json"));
  assert.throws(() => new JobStore(owner.directory, identity, profile), /identity is missing/);
  writeFileSync(path.join(owner.directory, "identity.json"), JSON.stringify(identity));
  const db = new Database(path.join(directory, "state.db"));
  try {
    db.prepare("UPDATE owner_jobs SET payload = ? WHERE job_id = ?").run(JSON.stringify({ version: 2, id: "uncertain" }), "uncertain");
    assert.throws(() => new JobStore(owner.directory, identity, profile), /Invalid headless job record/);
  } finally { db.close(); }
});

for (const [fixture, expected] of [["silent-codex.js", /timeout/], ["invalid-codex.js", /Invalid Codex response/]]) {
  test(`App Server ${fixture} fails pending requests and cleans up`, { timeout: 5000 }, async () => {
    const command = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
    chmodSync(command, 0o755);
    const codex = new Codex({ command, home: "/fixture", workspace: process.cwd(), timeout: 500,
      onNotification: () => {}, onRequest: () => {}, onFailure: () => {} });
    try { await assert.rejects(codex.initialize(), expected); } finally { await codex.stop(); }
  });
}
