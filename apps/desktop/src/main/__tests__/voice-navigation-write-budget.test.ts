import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenThreadInUi } from "../native-voice/open-thread-in-ui";
import { publishOperatorFocus, resetOperatorFocusRegistry } from "../native-voice/operator-focus-registry";
import { ensureWindowThreadMounted } from "../../renderer/src/lib/ensure-window-thread-mounted";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { ThreadSearchStore } from "../thread-search/thread-search-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

vi.mock("../primary-main-window", () => ({ primaryMainWindowWebContents: () => undefined }));
vi.mock("../window-show-thread", () => ({ requestShowThread: vi.fn() }));

let root: string;
let db: StateDb;
beforeEach(() => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  root = mkdtempSync(path.join(os.tmpdir(), "pwragent-voice-navigation-"));
  db = StateDb.open(path.join(root, "state.db"));
  resetOperatorFocusRegistry();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("preserves a persisted off-page peer pin without writes when opening it", async () => {
  const store = new SqliteOverlayStore(db);
  const target = { scope: "remote" as const, instanceId: "peer" };
  const ref = { backend: "codex" as const, threadId: "off-page", target };
  const summary: NavigationThreadSummary = {
    id: ref.threadId, source: ref.backend, title: "Saved peer summary", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false },
  };
  await store.addRemoteThreadPin({ ref, instanceLabel: "Saved peer label", summary, addedAt: 123, pinnedVia: "companion" });
  await store.setRemoteThreadLocalPin({ ref, pinnedRank: "a0" });
  const before = (await store.listRemoteThreadPins())[0];
  const { writes } = await measureSqliteWrites(async () => {
    for (let index = 0; index < 100; index += 1) {
      await ensureWindowThreadMounted({
        hasRemoteThreadPin: async (request) => await store.hasRemoteThreadPin(request),
        addRemoteThreadPin: async (request) => ({ pin: await store.addRemoteThreadPin({ ...request, instanceLabel: target.instanceId, pinnedVia: "explicit" }) }),
      }, { backend: ref.backend, threadId: ref.threadId, federationTarget: target }, [], false);
    }
  });
  expect((await store.listRemoteThreadPins())[0]).toEqual(before);
  expect(writes.commits).toBe(0);
  expectSqliteWriteBudget({ scenario: "voice-open-thread-persisted-off-page-peer", writes,
    note: "100 opens with an empty loaded page and an existing ranked peer pin: exact persisted lookup preserves the complete pin payload, zero commits and 0 MB/day." });
});

it("budgets a first peer mount and 100 repeated graphical opens", async () => {
  const store = new SqliteOverlayStore(db);
  const webContents = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }) as unknown as WebContents;
  const target = { scope: "remote" as const, instanceId: "peer" };
  const args = { backend: "codex" as const, threadId: "archived", instanceId: "peer" };
  const thread: NavigationThreadSummary = {
    id: args.threadId, source: args.backend, title: "Archived fixture", titleSource: "explicit",
    archivedAt: 100, linkedDirectories: [], inbox: { inInbox: false },
    federation: { ref: { backend: args.backend, threadId: args.threadId, target }, instanceLabel: "Fixture peer" },
  };
  let mounted: NavigationThreadSummary[] = [];
  let navigation: Promise<void> = Promise.resolve();
  const open = createOpenThreadInUi({
    window: () => webContents,
    localInstanceId: async () => "local",
    send: (request) => {
      navigation = (async () => {
        await ensureWindowThreadMounted({
          hasRemoteThreadPin: async (request) => await store.hasRemoteThreadPin(request),
          addRemoteThreadPin: async (request) => ({ pin: await store.addRemoteThreadPin({ ...request, instanceLabel: target.instanceId, pinnedVia: "explicit" }) }),
        }, request, mounted, false);
        mounted = [thread];
        publishOperatorFocus({ webContents, focus: { view: "thread", thread: { ...args, title: thread.title } } });
      })();
      return webContents;
    },
  });
  const { writes } = await measureSqliteWrites(async () => {
    for (let index = 0; index < 101; index += 1) {
      expect((await open(args)).ok).toBe(true);
      await navigation;
    }
  });
  expectSqliteWriteBudget({ scenario: "voice-open-thread-first-peer-mount", writes,
    note: "One peer mount through the UI pin API, then 100 opens of the mounted thread; only initial pin/owner persistence writes, no focus or timer writes." });
});

it("budgets global search over active and archived threads", async () => {
  const service = new ThreadSearchService(new ThreadSearchStore(db), async ({ archived }) => [{
    id: archived ? "archived" : "active", source: "codex", title: "Signing fixture", titleSource: "explicit",
    linkedDirectories: [], ...(archived ? { archivedAt: 100 } : {}),
  }]);
  const { writes } = await measureSqliteWrites(async () => {
    for (let index = 0; index < 2; index += 1) {
      const result = await service.search({ query: "Signing", filters: { includeArchived: true }, contentMode: "available" });
      expect(result.results).toHaveLength(2);
    }
  });
  expectSqliteWriteBudget({ scenario: "global-search-active-and-archived", writes,
    note: "Two global searches with active and archived fixtures: one initial index transaction, unchanged repeat search writes nothing; no background writes." });
});
