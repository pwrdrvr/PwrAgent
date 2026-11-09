import { ownerStorage } from "./helpers/owner-storage.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NavigationQueryStore, NAVIGATION_QUERY_MAX_RESULT_BYTES } from "../dist/federation-core.js";
import { fixtureCodexClient } from "./helpers/codex-client.js";
import { HeadlessBackend } from "../src/federation-backend.js";

function backendFixture(t, jobs, published = []) {
  const local = fileURLToPath(new URL("../../../.local/", import.meta.url));
  mkdirSync(local, { recursive: true });
  const directory = mkdtempSync(path.join(local, "navigation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = ownerStorage(t, directory);
  const runtime = { projects: { list: () => [{ path: directory, label: "Fixture" }] }, workspace: directory, loadedThreads: new Set(), store: { directory: path.join(owner.directory, "jobs"), jobs, threadRegistry: owner.threadRegistry, inventory: owner.inventory },
    codex: { renameThread: async ({ threadId }) => ({ threadId }) },
    onFailure: (error) => { throw error; } };
  return new HeadlessBackend(runtime, (event, eventClass) => published.push({ eventClass, ...event.notification }));
}

// What a viewer sends to mark a thread read: the update it displayed.
function markRead(backend, threadId) {
  return backend.handle("markThreadSeen", { threadId, seenUpdatedAt: backend.summary(backend.owned(threadId)).updatedAt });
}

function job(id, threadId, createdAt, updatedAt = createdAt) {
  return { id, threadId, createdAt, updatedAt, status: "completed", sandbox: "read-only" };
}

test("10,000-thread navigation indexes jobs once and updates the index at job boundaries", async (t) => {
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
  const page = await backend.handle("getNavigationQueryPage", request);
  assert.equal(page.entries.length, 10);
  assert.equal(page.counts.total, 10000);
  assert.equal(page.selectionDirectory.path, backend.runtime.workspace);
  assert.equal(page.selectionDirectory.counts.total, 10000);
  assert.equal((await backend.handle("getNavigationQueryPage", { ...request, cursor: page.nextCursor })).rangeStart, 10);
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

test("directory pages retain creation order while Updated pages follow recent activity", async (t) => {
  const old = job("old-job", "old", "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
  const newer = job("new-job", "new", "2026-01-02T00:00:00.000Z");
  const backend = backendFixture(t, new Map([[old.id, old], [newer.id, newer]]));
  const directory = { protocol: 2, query: { kind: "directory", directoryKey: backend.runtime.workspace }, pageSize: 1 };
  const first = await backend.handle("getNavigationQueryPage", directory);
  assert.equal(first.entries[0].row.id, "new");
  assert.equal((await backend.handle("getNavigationQueryPage", { ...directory, cursor: first.nextCursor })).entries[0].row.id, "old");
  assert.equal((await backend.handle("getNavigationQueryPage", { protocol: 2, query: { kind: "lens", lens: "inbox" } })).entries[0].row.id, "old");
  assert.equal((await backend.handle("getNavigationQueryPage", { protocol: 2, query: { kind: "lens", lens: "recents" } })).entries[0].row.id, "new");
});

test("replay normalizes turn status on messages and activities for mid-turn hydration", async (t) => {
  const backend = backendFixture(t, new Map([["job", job("job", "thread", "2026-01-01T00:00:00.000Z")]]));
  const statuses = ["completed", "failed", "interrupted", "cancelled", "inProgress"];
  backend.runtime.codex = fixtureCodexClient(async () => ({ thread: { turns: statuses.map((status) => ({
    id: `turn-${status}`, status, items: [
      { id: `message-${status}`, type: "agentMessage", text: "Working" },
      { id: `command-${status}`, type: "commandExecution", command: "fixture", status: "inProgress" },
    ],
  })) } }));
  const result = await backend.readThread("thread");
  for (const entry of result.replay.entries) {
    const expected = entry.turn.id === "turn-inProgress" ? "in_progress" : entry.turn.id.slice(5);
    assert.equal(entry.turn.status, expected);
  }
  assert.deepEqual(result.replay.entries.at(-1).turn, { id: "turn-inProgress", status: "in_progress" });
  assert.deepEqual(result.replay.messages.map((message) => message.text), ["Working"], "the shared client deduplicates repeated message summaries");
});

test("federated transcript reads return the newest page and page back by cursor", async (t) => {
  const backend = backendFixture(t, new Map([["job", job("job", "thread", "2026-01-01T00:00:00.000Z")]]));
  backend.runtime.codex = fixtureCodexClient(async () => ({ thread: { turns: [1, 2, 3].map((n) => ({
    id: `turn-${n}`, status: "completed", items: [
      { id: `user-${n}`, type: "userMessage", content: [{ type: "text", text: `Question ${n}` }] },
      { id: `answer-${n}`, type: "agentMessage", text: `Answer ${n}` },
    ],
  })) } }));
  // read_thread on a viewer keeps the first `limit` entries of what the owner
  // returns, so an unpaged owner showed the oldest turn of a long thread.
  const newest = (await backend.handle("readThread", { threadId: "thread", limit: 1 })).replay;
  assert.deepEqual(newest.entries.map((entry) => entry.id), ["user-3", "answer-3"]);
  assert.equal(newest.lastAssistantMessage, "Answer 3");
  assert.deepEqual(newest.pagination, { supportsPagination: true, hasPreviousPage: true, previousCursor: "user-3" });
  const older = (await backend.handle("readThread", { threadId: "thread", limit: 1, before: newest.pagination.previousCursor })).replay;
  assert.deepEqual(older.entries.map((entry) => entry.id), ["user-2", "answer-2"]);
  const oldest = (await backend.handle("readThread", { threadId: "thread", limit: 1, before: older.pagination.previousCursor })).replay;
  assert.deepEqual(oldest.entries.map((entry) => entry.id), ["user-1", "answer-1"]);
  assert.equal(oldest.pagination.hasPreviousPage, false);
  const whole = (await backend.handle("readThread", { threadId: "thread" })).replay;
  assert.equal(whole.entries.length, 6, "an unbounded read still returns the whole transcript");
  assert.equal((await backend.readThread("thread")).replay.entries.length, 6, "handoff export reads stay unpaged");
  assert.deepEqual((await backend.handle("readThread", { threadId: "thread", includeTurns: false })).replay.entries, []);
  for (const before of ["", "missing"]) {
    const unresolved = (await backend.handle("readThread", { threadId: "thread", limit: 1, before })).replay;
    assert.deepEqual(unresolved.entries, [], `cursor ${JSON.stringify(before)} must not restart at the newest page`);
    assert.equal(unresolved.pagination.hasPreviousPage, false);
  }
});

test("federated transcript pages fit the frame budget and keep a cursor to the trimmed entries", async (t) => {
  const backend = backendFixture(t, new Map([["job", job("job", "thread", "2026-01-01T00:00:00.000Z")]]));
  backend.replayByteBudget = 20_000;
  backend.runtime.codex = fixtureCodexClient(async () => ({ thread: { turns: [{ id: "turn-1", status: "completed", items: [
    { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Run it" }] },
    { id: "command-1", type: "commandExecution", command: "find /", aggregatedOutput: "x".repeat(200_000), status: "completed" },
    { id: "answer-1", type: "agentMessage", text: "Done" },
  ] }] } }));
  const response = await backend.handle("readThread", { threadId: "thread", limit: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= backend.replayByteBudget);
  assert.deepEqual(response.replay.entries.map((entry) => entry.id), ["answer-1"]);
  assert.deepEqual(response.replay.pagination, { supportsPagination: true, hasPreviousPage: true, previousCursor: "answer-1" });
  const older = await backend.handle("readThread", { threadId: "thread", limit: 1, before: "answer-1" });
  assert.ok(Buffer.byteLength(JSON.stringify(older)) <= backend.replayByteBudget);
  assert.deepEqual(older.replay.entries.map((entry) => entry.id), ["activity-command-1"], "the oversized entry is compacted, not lost");
  assert.match(older.replay.entries[0].summary, /exceeded the federation frame limit/);
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
  const refreshed = await reopened.handle("markThreadSeen", { threadId: "thread" });
  assert.equal(refreshed.seenUpdatedAt, undefined, "the response echoes only a requested watermark");
  assert.equal(reopened.owned("thread").seenUpdatedAt, seenUpdatedAt, "an omitted watermark keeps the stored one");
  assert.equal(reopened.summary(reopened.owned("thread")).inbox.inInbox, true);
  await markRead(reopened, "thread");
  assert.equal(reopened.summary(reopened.owned("thread")).inbox.inInbox, false);
  await reopened.handle("markThreadSeen", { threadId: "thread", seenUpdatedAt: 0 });
  assert.equal(reopened.summary(reopened.owned("thread")).inbox.inInbox, true, "zero is a watermark, not a missing value");
  for (const invalid of [-1, NaN, "yesterday"]) {
    await assert.rejects(reopened.handle("markThreadSeen", { threadId: "thread", seenUpdatedAt: invalid }), /Invalid seenUpdatedAt/);
  }
});

test("marking seen without a watermark never changes unread state, and is announced", async (t) => {
  const unseen = job("unseen-job", "unseen", "2026-01-01T00:00:00.000Z");
  const legacy = job("legacy-job", "legacy", "2026-01-01T00:00:00.000Z");
  const published = [];
  const backend = backendFixture(t, new Map([[unseen.id, unseen], [legacy.id, legacy]]), published);
  // A registry written before watermarks existed judged unread by seenAt.
  backend.persist({ ...backend.owned("legacy"), seenAt: Date.parse("2026-01-02T00:00:00.000Z") });
  assert.equal(backend.summary(backend.owned("unseen")).inbox.inInbox, true);
  assert.equal(backend.summary(backend.owned("legacy")).inbox.inInbox, false);
  for (const threadId of ["unseen", "legacy"]) await backend.handle("markThreadSeen", { threadId, seenAt: Date.parse("2026-01-03T00:00:00.000Z") });
  assert.equal(backend.summary(backend.owned("unseen")).inbox.inInbox, true, "a later seenAt does not read the thread");
  assert.equal(backend.summary(backend.owned("legacy")).inbox.inInbox, false);
  assert.deepEqual(published.filter((event) => event.params.threadId === "unseen"), [
    { eventClass: "transcript", method: "navigation/thread/seen", params: { threadId: "unseen" } },
    { eventClass: "navigation", method: "navigation/invalidated", params: { threadId: "unseen", sourceMethod: "navigation/thread/seen" } },
  ]);
});

test("continuation cursors retain their snapshot across global count changes and expire when idle", async (t) => {
  const jobs = new Map(["match-a", "match-b", "other"].map((id) => [id, job(id, id, "2026-01-01T00:00:00.000Z")]));
  const backend = backendFixture(t, jobs);
  let now = 0;
  backend.navigation = new NavigationQueryStore({ now: () => now });
  const request = { protocol: 2, query: { kind: "lens", lens: "inbox", filter: "match" }, pageSize: 1 };
  const first = await backend.handle("getNavigationQueryPage", request);
  assert.equal((await backend.handle("getNavigationQueryPage", { ...request, cursor: first.nextCursor })).rangeStart, 1);
  await backend.handle("markThreadSeen", { threadId: "other", seenUpdatedAt: Date.parse("2026-01-01T00:00:00.000Z") });
  const refreshed = await backend.handle("getNavigationQueryPage", request);
  assert.notEqual(refreshed.generation, first.generation, "the new generation includes changed global counts");
  assert.notEqual(refreshed.countsRevision, first.countsRevision);
  const retained = await backend.handle("getNavigationQueryPage", { ...request, cursor: first.nextCursor });
  assert.equal(retained.countsRevision, first.countsRevision, "an issued cursor keeps its original counts");
  const next = await backend.handle("getNavigationQueryPage", { ...request, cursor: refreshed.nextCursor });
  assert.equal(next.rangeStart, 1);
  assert.equal(next.countsRevision, refreshed.countsRevision);
  now = 60_001;
  await assert.rejects(backend.handle("getNavigationQueryPage", { ...request, cursor: next.nextCursor || refreshed.nextCursor }), /cursor expired/);
});

test("navigation pages fit the shared byte budget and scope retained cursors to their requester and owner", async (t) => {
  const jobs = new Map(Array.from({ length: 60 }, (_, i) => [`job-${i}`, job(`job-${i}`, `thread-${i}`, "2026-01-01T00:00:00.000Z")]));
  const backend = backendFixture(t, jobs);
  for (const thread of backend.threads.values()) backend.persist({ ...thread, title: "x".repeat(6000) });
  const request = { protocol: 2, query: { kind: "lens", lens: "inbox" }, pageSize: 100 };
  const envelope = { sourceInstanceId: "viewer-a" };
  let page = await backend.handle("getNavigationQueryPage", request, envelope);
  assert.ok(page.entries.length > 0 && page.entries.length < 60, "the byte budget shortens the requested page");
  const cursor = page.nextCursor;
  const ids = [];
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 60, "every page must advance");
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= NAVIGATION_QUERY_MAX_RESULT_BYTES);
    ids.push(...page.entries.map((entry) => entry.row.id));
    if (page.complete) break;
    page = await backend.handle("getNavigationQueryPage", { ...request, cursor: page.nextCursor }, envelope);
  }
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
  await assert.rejects(backend.handle("getNavigationQueryPage", { ...request, cursor }, { sourceInstanceId: "viewer-b" }), /does not belong/);
  const reopened = new HeadlessBackend(backend.runtime, () => {});
  await assert.rejects(reopened.handle("getNavigationQueryPage", { ...request, cursor }, envelope), /cursor expired/);
});

for (const promoteOnTurnEnd of [true, false]) {
  test(`Attention ranks follow turns and membership with completion promotion ${promoteOnTurnEnd}`, async (t) => {
    const old = job("old-job", "old", "2026-01-01T00:00:00.000Z");
    const newer = job("new-job", "new", "2026-01-02T00:00:00.000Z");
    const jobs = new Map([[old.id, old], [newer.id, newer]]);
    const backend = backendFixture(t, jobs);
    const request = { protocol: 2, query: { kind: "lens", lens: "attention" },
      attentionView: { id: "window", promoteOnTurnEnd } };
    const page = () => backend.handle("getNavigationQueryPage", request);
    const ids = async () => (await page()).entries.map((entry) => entry.row.id);
    const rank = async (id) => (await page()).entries.find((entry) => entry.row.id === id)?.attentionRank;
    const update = (value) => { jobs.set(value.id, value); backend.event({ method: "headless/jobChanged", params: value }); };
    assert.deepEqual(await ids(), ["new", "old"]);
    const waitingRank = await rank("old");
    await backend.handle("renameThread", { threadId: "old", title: "Renamed waiting work" });
    assert.deepEqual(await ids(), ["new", "old"]);
    assert.equal(await rank("old"), waitingRank);
    update({ ...old, id: "old-next", status: "running", createdAt: "2026-01-03T00:00:00.000Z" });
    assert.deepEqual(await ids(), ["old", "new"]);
    const runningRank = await rank("old");
    update({ ...jobs.get("old-next"), status: "interrupting", updatedAt: "2026-01-04T00:00:00.000Z" });
    await backend.handle("renameThread", { threadId: "old", title: "Renamed live work" });
    assert.equal(await rank("old"), runningRank);
    update({ ...newer, id: "new-next", status: "running", createdAt: "2026-01-05T00:00:00.000Z" });
    assert.deepEqual(await ids(), ["new", "old"]);
    update({ ...jobs.get("old-next"), status: "completed", finishedAt: "2026-01-06T00:00:00.000Z" });
    assert.deepEqual(await ids(), promoteOnTurnEnd ? ["old", "new"] : ["new", "old"]);
    const finishedRank = await rank("old");
    update({ ...jobs.get("old-next"), updatedAt: "2026-01-07T00:00:00.000Z" });
    assert.equal(await rank("old"), finishedRank, "repeated completion/activity cannot move a turn again");
    const filtered = await backend.handle("getNavigationQueryPage", { ...request, query: { ...request.query, filter: "Renamed" } });
    assert.equal(filtered.entries[0].attentionRank, finishedRank, "filtering never resets membership ranks");
    await markRead(backend, "old");
    assert.deepEqual(await ids(), ["new"]);
    await backend.handle("markThreadSeen", { threadId: "old", seenUpdatedAt: 0 });
    assert.deepEqual(await ids(), ["old", "new"]);
    assert.ok((await rank("old")) > finishedRank, "reentry earns a new membership rank");
    const beforeUnobserved = await rank("old");
    update({ ...old, id: "unobserved", createdAt: "2026-01-08T00:00:00.000Z" });
    assert.equal((await rank("old")) > beforeUnobserved, true, "a complete new job between queries is a turn boundary");
    const beforeReentry = await rank("old");
    await markRead(backend, "old");
    await backend.handle("markThreadSeen", { threadId: "old", seenUpdatedAt: 0 });
    assert.ok((await rank("old")) > beforeReentry, "membership removal is observed even between queries");
    await backend.handle("releaseNavigationAttentionView", { viewId: "window" });
    await assert.rejects(page(), /Attention view has closed/);
    assert.equal((await backend.handle("getNavigationQueryPage", { ...request, attentionView: { ...request.attentionView, id: "new-window" } })).entries.length, 2);
  });
  for (const readDuringStartup of [true, false]) {
    test(`startup keeps one Attention rank with promotion ${promoteOnTurnEnd} and startup read ${readDuringStartup}`, async (t) => {
      const old = { ...job("old-job", "thread", "2026-01-01T00:00:00.000Z"), status: "running", turnId: "turn-old" };
      const jobs = new Map([[old.id, old]]);
      const backend = backendFixture(t, jobs);
      const request = { protocol: 2, query: { kind: "lens", lens: "attention" },
        attentionView: { id: "window", promoteOnTurnEnd } };
      const rank = async () => (await backend.handle("getNavigationQueryPage", request)).entries[0].attentionRank;
      const update = (value) => { jobs.set(value.id, value); backend.event({ method: "headless/jobChanged", params: value }); };
      await rank();
      update(old);
      update({ ...old, status: "completed", updatedAt: "2026-01-02T00:00:00.000Z" });
      const previousRank = await rank();

      // Runtime saves the accepted job before Codex assigns its turn ID.
      const starting = { ...job("next-job", "thread", "2026-01-03T00:00:00.000Z"), status: "starting" };
      update(starting);
      if (readDuringStartup) {
        assert.equal(await rank(), previousRank + 1);
        // Resuming the provider thread saves the same starting job again.
        update({ ...starting, updatedAt: "2026-01-04T00:00:00.000Z" });
        assert.equal(await rank(), previousRank + 1);
      }
      backend.event({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn-next" } } });
      const startedRank = await rank();
      assert.equal(startedRank, previousRank + 1, "the provider turn ID adopts the accepted start's rank");
      const running = { ...starting, status: "running", turnId: "turn-next", updatedAt: "2026-01-05T00:00:00.000Z" };
      update(running);
      assert.equal(await rank(), startedRank, "saving the canonical turn ID cannot allocate another start rank");

      update({ ...running, status: "completed", updatedAt: "2026-01-06T00:00:00.000Z" });
      backend.event({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-next", status: "completed" } } });
      assert.equal(await rank(), startedRank + Number(promoteOnTurnEnd), "only completion promotion can move the turn again");
    });
  }

}
