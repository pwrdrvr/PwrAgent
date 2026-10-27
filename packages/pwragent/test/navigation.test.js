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
  const runtime = { workspace: directory, loadedThreads: new Set(), store: { directory: path.join(directory, "jobs"), jobs },
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

test("replay normalizes turn status on messages and activities for mid-turn hydration", async (t) => {
  const backend = backendFixture(t, new Map([["job", job("job", "thread", "2026-01-01T00:00:00.000Z")]]));
  const statuses = ["completed", "failed", "interrupted", "cancelled", "inProgress"];
  backend.runtime.codex = { request: async () => ({ thread: { turns: statuses.map((status) => ({
    id: `turn-${status}`, status, items: [
      { id: `message-${status}`, type: "agentMessage", text: "Working" },
      { id: `command-${status}`, type: "commandExecution", command: "fixture", status: "inProgress" },
    ],
  })) } }) };
  const result = await backend.readThread("thread");
  for (const entry of result.replay.entries) {
    const expected = entry.turn.id === "turn-inProgress" ? "in_progress" : entry.turn.id.slice(5);
    assert.equal(entry.turn.status, expected);
  }
  assert.deepEqual(result.replay.entries.at(-1).turn, { id: "turn-inProgress", status: "in_progress" });
  assert.deepEqual(result.replay.messages.at(-1).turn, { id: "turn-inProgress", status: "in_progress" });
});

test("seen acknowledgements retain the displayed update watermark across a newer result and restart", async (t) => {
  const value = job("job", "thread", "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
  const backend = backendFixture(t, new Map([[value.id, value]]));
  const seenUpdatedAt = Date.parse("2026-01-02T00:00:00.000Z");
  const seenAt = Date.parse("2026-01-04T00:00:00.000Z");
  assert.deepEqual(await backend.handle("markThreadSeen", { threadId: "thread", seenAt, seenUpdatedAt }),
    { backend: "codex", threadId: "thread", seenAt, seenUpdatedAt });
  assert.equal(backend.summary(backend.owned("thread")).inbox.inInbox, true);
  const reopened = new HeadlessBackend(backend.runtime, () => {});
  assert.equal(reopened.owned("thread").seenUpdatedAt, seenUpdatedAt);
  assert.equal(reopened.summary(reopened.owned("thread")).inbox.inInbox, true);
  const acknowledged = await reopened.handle("markThreadSeen", { threadId: "thread" });
  assert.equal(acknowledged.seenUpdatedAt, Date.parse(value.updatedAt), "omitted watermark acknowledges current content");
  assert.equal(reopened.summary(reopened.owned("thread")).inbox.inInbox, false);
  await reopened.handle("markThreadSeen", { threadId: "thread", seenUpdatedAt: 0 });
  assert.equal(reopened.summary(reopened.owned("thread")).inbox.inInbox, true, "zero is a watermark, not a missing value");
  for (const invalid of [-1, NaN, "yesterday"]) {
    await assert.rejects(reopened.handle("markThreadSeen", { threadId: "thread", seenUpdatedAt: invalid }), /Invalid seenUpdatedAt/);
  }
});

test("filtered continuation cursors expire when unrelated global counts change", async (t) => {
  const jobs = new Map(["match-a", "match-b", "other"].map((id) => [id, job(id, id, "2026-01-01T00:00:00.000Z")]));
  const backend = backendFixture(t, jobs);
  const request = { protocol: 2, query: { kind: "lens", lens: "inbox", filter: "match" }, pageSize: 1 };
  const first = backend.query(request);
  assert.equal(backend.query({ ...request, cursor: first.nextCursor }).rangeStart, 1);
  await backend.handle("markThreadSeen", { threadId: "other", seenUpdatedAt: Date.parse("2026-01-01T00:00:00.000Z") });
  const refreshed = backend.query(request);
  assert.equal(refreshed.generation, first.generation, "filtered rows are unchanged");
  assert.notEqual(refreshed.countsRevision, first.countsRevision);
  assert.throws(() => backend.query({ ...request, cursor: first.nextCursor }), /cursor expired/);
  const next = backend.query({ ...request, cursor: refreshed.nextCursor });
  assert.equal(next.rangeStart, 1);
  assert.equal(next.countsRevision, refreshed.countsRevision);
});

for (const promoteOnTurnEnd of [true, false]) {
  test(`Attention ranks follow turns and membership with completion promotion ${promoteOnTurnEnd}`, async (t) => {
    const old = job("old-job", "old", "2026-01-01T00:00:00.000Z");
    const newer = job("new-job", "new", "2026-01-02T00:00:00.000Z");
    const jobs = new Map([[old.id, old], [newer.id, newer]]);
    const backend = backendFixture(t, jobs);
    const request = { protocol: 2, query: { kind: "lens", lens: "attention" },
      attentionView: { id: "window", promoteOnTurnEnd } };
    const page = () => backend.query(request);
    const ids = () => page().entries.map((entry) => entry.row.id);
    const rank = (id) => page().entries.find((entry) => entry.row.id === id)?.attentionRank;
    const update = (value) => { jobs.set(value.id, value); backend.event({ method: "headless/jobChanged", params: value }); };
    assert.deepEqual(ids(), ["new", "old"]);
    const waitingRank = rank("old");
    await backend.handle("renameThread", { threadId: "old", title: "Renamed waiting work" });
    assert.deepEqual(ids(), ["new", "old"]);
    assert.equal(rank("old"), waitingRank);
    update({ ...old, id: "old-next", status: "running", createdAt: "2026-01-03T00:00:00.000Z" });
    assert.deepEqual(ids(), ["old", "new"]);
    const runningRank = rank("old");
    update({ ...jobs.get("old-next"), status: "interrupting", updatedAt: "2026-01-04T00:00:00.000Z" });
    await backend.handle("renameThread", { threadId: "old", title: "Renamed live work" });
    assert.equal(rank("old"), runningRank);
    update({ ...newer, id: "new-next", status: "running", createdAt: "2026-01-05T00:00:00.000Z" });
    assert.deepEqual(ids(), ["new", "old"]);
    update({ ...jobs.get("old-next"), status: "completed", finishedAt: "2026-01-06T00:00:00.000Z" });
    assert.deepEqual(ids(), promoteOnTurnEnd ? ["old", "new"] : ["new", "old"]);
    const finishedRank = rank("old");
    update({ ...jobs.get("old-next"), updatedAt: "2026-01-07T00:00:00.000Z" });
    assert.equal(rank("old"), finishedRank, "repeated completion/activity cannot move a turn again");
    const filtered = backend.query({ ...request, query: { ...request.query, filter: "Renamed" } });
    assert.equal(filtered.entries[0].attentionRank, finishedRank, "filtering never resets membership ranks");
    await backend.handle("markThreadSeen", { threadId: "old" });
    assert.deepEqual(ids(), ["new"]);
    await backend.handle("markThreadSeen", { threadId: "old", seenUpdatedAt: 0 });
    assert.deepEqual(ids(), ["old", "new"]);
    assert.ok(rank("old") > finishedRank, "reentry earns a new membership rank");
    const beforeUnobserved = rank("old");
    update({ ...old, id: "unobserved", createdAt: "2026-01-08T00:00:00.000Z" });
    assert.equal(rank("old") > beforeUnobserved, promoteOnTurnEnd, "a complete new job between queries is a turn boundary");
    const beforeReentry = rank("old");
    await backend.handle("markThreadSeen", { threadId: "old" });
    await backend.handle("markThreadSeen", { threadId: "old", seenUpdatedAt: 0 });
    assert.ok(rank("old") > beforeReentry, "membership removal is observed even between queries");
    await backend.handle("releaseNavigationAttentionView", { viewId: "window" });
    assert.equal(backend.attentionViews.has("window"), false);
  });
}
