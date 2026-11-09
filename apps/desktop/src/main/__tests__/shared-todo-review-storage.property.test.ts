import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadReview, ThreadTodo, ThreadTodoModelSettings } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { ThreadTodoStore as SharedTodo } from "@pwragent/sqlite-storage/thread-todo-store";
import { SqliteThreadReviewStorage as SharedReview } from "@pwragent/sqlite-storage/thread-review-storage-sqlite";
import * as sharedRecents from "@pwragent/sqlite-storage/model-settings-recents-store";
import { ThreadTodoStore as DesktopTodo } from "../storage/thread-todo-store";
import { SqliteThreadReviewStorage as DesktopReview } from "../storage/thread-review-storage-sqlite";
import * as desktopRecents from "../storage/model-settings-recents-store";
import * as stateRecents from "../state/model-settings-recents-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const backends = ["codex", "claude", "acp:kimi"] as const;
const todoBindings = [SharedTodo, DesktopTodo];
const reviewBindings = [SharedReview, DesktopReview];
const actor = (index: number) => ({ backend: backends[index % 3]!, threadId: "same-provider-id" });
afterEach(() => vi.unstubAllEnvs());

it("binds every concrete desktop export to the functioning portable implementation", () => {
  fc.assert(fc.property(fc.constantFrom("todo", "review", "desktop-recents", "state-recents"), binding => {
    if (binding === "todo") expect(DesktopTodo).toBe(SharedTodo);
    if (binding === "review") expect(DesktopReview).toBe(SharedReview);
    if (binding.endsWith("recents")) {
      const recents = binding === "state-recents" ? stateRecents : desktopRecents;
      expect(recents.recordModelSettingsRecent).toBe(sharedRecents.recordModelSettingsRecent);
      expect(recents.listModelSettingsRecents).toBe(sharedRecents.listModelSettingsRecents);
    }
  }));
});

// A card belongs to a backend-qualified thread. Content edits retain its
// identity/history; status, checklist and error updates affect only that card.
// The independent model holds public records, with no SQL or store helpers.
it("matches a card model through alternating hosts, WAL readers and reopen order", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    card: fc.integer({ min: 0, max: 5 }), host: fc.integer({ min: 0, max: 1 }),
    operation: fc.constantFrom("edit", "status", "items", "error", "archive", "reopen"),
    text: fc.string({ minLength: 1, maxLength: 25 }),
    status: fc.constantFrom("open", "done", "dismissed"), checked: fc.boolean(),
  }), { minLength: 1, maxLength: 30 }), async commands => {
    const fixture = createTempStateDb("shared-card-model-");
    const connections = todoBindings.map(() => StateDb.open(fixture.dbPath));
    const stores = connections.map((db, i) => new todoBindings[i]!(db));
    const model = new Map<string, ThreadTodo>();
    let now = 100;
    try {
      for (let i = 0; i < 6; i++) {
        const record = { id: `card-${i}`, ...actor(i), kind: "reminder" as const,
          title: `Card ${i}`, key: `key-${i}`, dependencyId: `dependency-${i}`, now: ++now };
        stores[i % 2]!.insert(record);
        model.set(record.id, { id: record.id, ...actor(i), kind: "reminder", title: record.title,
          key: record.key, dependencyId: record.dependencyId, status: "open", createdAt: now, updatedAt: now });
      }
      for (const command of commands) {
        now++;
        const id = `card-${command.card}`;
        const expected = model.get(id)!;
        const store = stores[command.host]!;
        if (command.operation === "edit") {
          store.replaceContent({ id, title: command.text, kind: "reminder", now });
          expected.title = command.text;
          expected.updatedAt = now;
          delete expected.items;
          delete expected.error;
        } else if (command.operation === "status") {
          store.setStatus({ id, status: command.status, now, result: { result: command.text } });
          expected.status = command.status;
          expected.updatedAt = now;
          if (command.status === "open") { delete expected.resolvedAt; delete expected.result; }
          else { expected.resolvedAt = now; expected.result = command.text; delete expected.error; }
        } else if (command.operation === "items") {
          const items = [{ id: "step", text: command.text, checked: command.checked, prerequisite: true as const }];
          store.setItems({ id, items, now });
          expected.items = items;
          expected.updatedAt = now;
        } else if (command.operation === "error") {
          store.setError({ id, error: command.text, now });
          expected.error = command.text;
          expected.updatedAt = now;
        } else if (command.operation === "archive") {
          const identity = actor(command.card);
          const open = [...model.values()].filter(card => card.backend === identity.backend && card.status === "open");
          expect(store.dismissOpenForThread({ ...identity, now })).toBe(open.length);
          for (const card of open) { card.status = "dismissed"; card.updatedAt = now; card.resolvedAt = now; }
        } else {
          connections[command.host]!.close();
          const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(reopened.writes.commits).toBe(0);
          connections[command.host] = reopened.result;
          stores[command.host] = new todoBindings[command.host]!(reopened.result);
        }
        const reads = await measureSqliteWrites(() => {
          const all = [...model.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
          for (const observer of stores) {
            expect(observer.list({ status: "all" })).toEqual(all);
            for (const card of all) {
              expect(observer.get(card.id)).toEqual(card);
              expect(observer.findByDependency(card.dependencyId!)).toEqual(card);
              expect(observer.findOpenByKey({ ...card, key: card.key! })).toEqual(card.status === "open" ? card : undefined);
            }
            for (const backend of backends) {
              const scoped = all.filter(card => card.backend === backend);
              expect(observer.list({ backend, threadId: "same-provider-id", status: "all", limit: 1 })).toEqual(scoped.slice(0, 1));
              expect(observer.countOpen({ backend, threadId: "same-provider-id" })).toBe(scoped.filter(card => card.status === "open").length);
            }
          }
        });
        expect([reads.writes.commits, reads.writes.statements, reads.writes.rowsChanged]).toEqual([0, 0, 0]);
      }
    } finally { for (const db of connections) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("preserves review ownership, ordering, enrollment and outcomes across host connections", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    review: fc.integer({ min: 0, max: 5 }), host: fc.integer({ min: 0, max: 1 }),
    status: fc.constantFrom("open", "handled", "dismissed"), enroll: fc.boolean(), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 25 }), async commands => {
    const fixture = createTempStateDb("shared-review-model-");
    const connections = reviewBindings.map(() => StateDb.open(fixture.dbPath));
    const stores = connections.map((db, i) => new reviewBindings[i]!(db));
    const model = new Map<string, ThreadReview>();
    let now = 100;
    try {
      for (let i = 0; i < 6; i++) {
        const review: ThreadReview = { ...actor(i), id: `review-${i}`, sourceKey: `artifact-${i}`,
          title: "Review", status: "open", items: [], createdAt: ++now, updatedAt: now };
        stores[i % 2]!.insert(review);
        model.set(review.id, review);
      }
      for (const command of commands) {
        const review = model.get(`review-${command.review}`)!;
        if (command.enroll) {
          review.origin = "explicit";
          stores[command.host]!.enrollReview(review.id, review);
        } else {
          review.status = command.status;
          review.updatedAt = ++now;
          stores[command.host]!.update(review);
        }
        if (command.reopen) {
          connections[command.host]!.close();
          connections[command.host] = StateDb.open(fixture.dbPath);
          stores[command.host] = new reviewBindings[command.host]!(connections[command.host]!);
        }
        const all = [...model.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        for (const store of stores) {
          expect([...store.iterate({ status: "all" })]).toEqual(all);
          expect([...store.iterate({})]).toEqual(all.filter(r => r.status === "open"));
          for (const backend of backends) expect([...store.iterate({ backend, threadId: "same-provider-id", status: "all" })])
            .toEqual(all.filter(r => r.backend === backend));
          for (const row of all) expect(store.get(row.id)).toEqual(row);
        }
      }
    } finally { for (const db of connections) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// A dispatch remembers only explicit changes until a preference exists.
// Recents are per scope, unique by the whole setting, newest first, capped at ten.
it("matches dispatch preferences and shared recents without changing commit counts", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    model: fc.integer({ min: 0, max: 14 }), high: fc.boolean(), host: fc.integer({ min: 0, max: 1 }),
    identity: fc.integer({ min: 0, max: 2 }), defaultPick: fc.boolean(),
  }), { minLength: 1, maxLength: 35 }), async commands => {
    const fixture = createTempStateDb("shared-dispatch-model-");
    const connections = todoBindings.map(() => StateDb.open(fixture.dbPath));
    const stores = connections.map((db, i) => new todoBindings[i]!(db));
    const prefs = new Map<number, ThreadTodoModelSettings>();
    let recents: ThreadTodoModelSettings[] = [];
    try {
      sharedRecents.recordModelSettingsRecent(connections[0]!, "composer", { backend: "codex", model: "composer" });
      for (const command of commands) {
        const identity = actor(command.identity);
        const settings = { backend: identity.backend, model: `model-${command.model}`, reasoningEffort: command.high ? "high" : "low" };
        const source = command.defaultPick ? settings : { backend: identity.backend, model: "default" };
        const previous = prefs.get(command.identity);
        const measured = await measureSqliteWrites(() => stores[command.host]!.rememberDispatch(
          identity.backend, identity.threadId, settings, source));
        const differs = !command.defaultPick;
        const changed = previous && (previous.model !== settings.model || previous.reasoningEffort !== settings.reasoningEffort);
        expect(measured.writes.commits).toBe(differs || changed ? 1 : 0);
        if (differs || previous) prefs.set(command.identity, settings);
        if (differs) recents = [settings, ...recents.filter(r => r.backend !== settings.backend
          || r.model !== settings.model || r.reasoningEffort !== settings.reasoningEffort)].slice(0, 10);
        for (const store of stores) for (let i = 0; i < 3; i++) {
          expect(store.getThreadModelSettings(actor(i).backend, actor(i).threadId)).toEqual(prefs.get(i));
        }
        for (const db of connections) {
          expect(sharedRecents.listModelSettingsRecents(db, "todo-dispatch")).toEqual(recents);
          expect(stateRecents.listModelSettingsRecents(db, "composer")).toEqual([{ backend: "codex", model: "composer" }]);
        }
      }
    } finally { for (const db of connections) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("retains immediate transaction rollback and one profile tracking boundary across hosts", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.string(), async (desktopFirst, title) => {
    const fixture = createTempStateDb("shared-metadata-rollback-");
    const db = StateDb.open(fixture.dbPath);
    const observer = StateDb.open(fixture.dbPath);
    const todo = new todoBindings[desktopFirst ? 1 : 0]!(db);
    const review = new reviewBindings[desktopFirst ? 1 : 0]!(db);
    try {
      const initialized = await measureSqliteWrites(() => review.trackingStartedAt(() => 123));
      expect(initialized.result).toBe(123);
      expect(initialized.writes.commits).toBe(1);
      const read = await measureSqliteWrites(() => new SharedReview(observer).trackingStartedAt(() => 999));
      expect(read.result).toBe(123);
      expect(read.writes.commits).toBe(0);
      for (const transaction of [todo.transaction.bind(todo), review.runExclusive.bind(review)]) {
        expect(() => transaction(() => {
          todo.insert({ id: "rolled-back", ...actor(0), kind: "reminder", title, now: 100 });
          review.insert({ id: "rolled-back", ...actor(0), title, sourceKey: "artifact", status: "open", items: [], createdAt: 100, updatedAt: 100 });
          todo.rememberDispatch("codex", "thread", { backend: "codex", model: "chosen" }, { backend: "codex" });
          expect(new SharedTodo(observer).get("rolled-back")).toBeUndefined();
          expect(new SharedReview(observer).get("rolled-back")).toBeUndefined();
          throw new Error("fixture rollback");
        })).toThrow("fixture rollback");
        expect(new SharedTodo(observer).get("rolled-back")).toBeUndefined();
        expect(new SharedReview(observer).get("rolled-back")).toBeUndefined();
        expect(sharedRecents.listModelSettingsRecents(observer, "todo-dispatch")).toEqual([]);
        expect(todo.getThreadModelSettings("codex", "thread")).toBeUndefined();
      }
    } finally { db.close(); observer.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 15 });
});
