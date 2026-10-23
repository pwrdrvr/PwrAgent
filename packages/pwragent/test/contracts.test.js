import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  const identity = { version: 1, workspace: "/fixture/workspace", codexHome: "/fixture/home" };
  const store = new JobStore(directory, identity);
  store.save({ version: 1, id: "uncertain", status: "running", fingerprint: "fixture", threadId: "thread-fixture" });
  const reopened = new JobStore(directory, identity);
  assert.equal(reopened.get("uncertain").status, "unknown");
  const before = readFileSync(path.join(directory, "jobs/uncertain.json"), "utf8");
  new JobStore(directory, identity);
  assert.equal(readFileSync(path.join(directory, "jobs/uncertain.json"), "utf8"), before, "no idle rewrite");
  assert.throws(() => new JobStore(directory, { ...identity, codexHome: "/different" }), /different workspace or Codex home/);
  unlinkSync(path.join(directory, "identity.json"));
  assert.throws(() => new JobStore(directory, identity), /identity is missing/);
  writeFileSync(path.join(directory, "identity.json"), JSON.stringify(identity));
  writeFileSync(path.join(directory, "jobs/uncertain.json"), "{");
  assert.throws(() => new JobStore(directory, identity), SyntaxError);
});

for (const [fixture, expected] of [["silent-codex.js", /timed out/], ["invalid-codex.js", /Invalid Codex response/]]) {
  test(`App Server ${fixture} fails pending requests and cleans up`, { timeout: 5000 }, async () => {
    const command = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
    chmodSync(command, 0o755);
    const codex = new Codex({ command, home: "/fixture", workspace: process.cwd(), timeout: 500,
      onNotification: () => {}, onRequest: () => {}, onFailure: () => {} });
    try { await assert.rejects(codex.initialize(), expected); } finally { await codex.stop(); }
  });
}
