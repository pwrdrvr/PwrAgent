import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HeadlessBackend } from "../src/federation-backend.js";

function backendFixture(t, jobs) {
  const local = fileURLToPath(new URL("../../../.local/", import.meta.url));
  mkdirSync(local, { recursive: true });
  const directory = mkdtempSync(path.join(local, "navigation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = { workspace: directory, store: { directory: path.join(directory, "jobs"), jobs },
    onFailure: (error) => { throw error; } };
  return new HeadlessBackend(runtime, () => {});
}

function job(id, threadId, createdAt, updatedAt = createdAt) {
  return { id, threadId, createdAt, updatedAt, status: "completed", sandbox: "read-only" };
}

test("10,000-thread navigation indexes jobs once and updates the index at job boundaries", (t) => {
  const jobs = new Map(Array.from({ length: 10000 }, (_, i) => {
    const value = job(`job-${i}`, `thread-${i}`, new Date(i * 1000).toISOString());
    return [value.id, value];
  }));
  let visits = 0;
  const values = jobs.values.bind(jobs);
  jobs.values = function* () { for (const value of values()) { visits++; yield value; } };
  const backend = backendFixture(t, jobs);
  assert.equal(visits, 10000, "one startup pass through the job registry");
  visits = 0;
  const request = { protocol: 2, query: { kind: "directory", directoryKey: backend.runtime.workspace }, pageSize: 10 };
  const page = backend.query(request);
  assert.equal(page.entries.length, 10);
  assert.equal(page.collectionSize, 10000);
  assert.equal(backend.query({ ...request, cursor: page.nextCursor }).rangeStart, 10);
  const latest = { ...job("continued", "thread-0", "2026-01-01T00:00:00.000Z"), status: "running", turnId: "turn-1" };
  jobs.set(latest.id, latest);
  backend.event({ method: "headless/jobChanged", params: latest });
  assert.equal(backend.summary(backend.owned("thread-0")).threadStatus, "active");
  const completed = { ...latest, status: "completed" };
  jobs.set(latest.id, completed);
  backend.event({ method: "headless/jobChanged", params: completed });
  backend.event({ method: "headless/jobChanged", params: jobs.get("job-0") });
  assert.equal(backend.latest("thread-0"), completed, "an older job update cannot replace the latest turn");
  assert.equal(backend.summary(backend.owned("thread-0")).threadStatus, "idle");
  assert.equal(visits, 0, "queries and boundary events never rescan the job registry");
  const reopened = backendFixture(t, jobs);
  assert.equal(reopened.latest("thread-0"), completed, "startup rebuild finds the latest persisted job");
});

test("directory pages retain creation order while Updated pages follow recent activity", (t) => {
  const old = job("old-job", "old", "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
  const newer = job("new-job", "new", "2026-01-02T00:00:00.000Z");
  const backend = backendFixture(t, new Map([[old.id, old], [newer.id, newer]]));
  const directory = { protocol: 2, query: { kind: "directory", directoryKey: backend.runtime.workspace }, pageSize: 1 };
  const first = backend.query(directory);
  assert.equal(first.entries[0].row.id, "new");
  assert.equal(backend.query({ ...directory, cursor: first.nextCursor }).entries[0].row.id, "old");
  assert.equal(backend.query({ protocol: 2, query: { kind: "lens", lens: "inbox" } }).entries[0].row.id, "old");
  assert.equal(backend.query({ protocol: 2, query: { kind: "lens", lens: "recents" } }).entries[0].row.id, "new");
});
