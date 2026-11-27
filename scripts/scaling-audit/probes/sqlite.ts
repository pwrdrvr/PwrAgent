import { createSource, fixtureStores } from "./scaling-audit-navigation-fixture";
import { expect, it, vi } from "vitest";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import * as directoryStore from "../git-info/directory-store";
import { StackReader } from "../stacks/stack-reader";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { generate } from "./scaling-audit-generate.mjs";
import { record } from "./scaling-audit-results";

const mocks = fixtureStores();
const copies = Number(process.env.AUDIT_COPIES);
const archiveControl = Number(process.env.AUDIT_ARCHIVED);
const cases = [[435, archiveControl], [869, 0], [869, archiveControl], [869, archiveControl * 2], [1738, archiveControl]];
it.each([...new Map(cases.map((pair) => [pair.join("/"), pair])).values()])(
  "measures twelve changes at %i live rows (before scaling), %i archived", async (live, archived) => {
    const n = live * copies;
    const rows = generate({ copies: Math.ceil(n / 869), archived });
    const threads = rows.threads.slice(0, n).map(({ pinnedRank, prs, parentThreadId, parentThreadBackend, ...row }) => row);
    const visible = new Set(threads.map((row) => row.id));
    const db = openInMemoryStateDb();
    const overlay = new SqliteOverlayStore(db);
    try {
      db.raw.transaction(() => {
        const put = db.raw.prepare("INSERT INTO threads(thread_id,payload) VALUES(?,?)");
        const insert = (row) => put.run(row.backend + ":" + row.threadId, JSON.stringify(row));
        for (const row of rows.threads.slice(0, n)) {
          insert({
            backend: row.source, threadId: row.id, pinnedRank: row.pinnedRank, prs: row.prs,
            lastSeenUpdatedAt: row.updatedAt + 1,
            ...(visible.has(row.parentThreadId) ? { parentThreadId: row.parentThreadId, parentThreadBackend: row.parentThreadBackend } : {}),
          });
        }
        rows.archivedOverlays.forEach(insert);
      })();
      mocks.profileStore = overlay;
      const source = createSource(threads);
      const store = new NavigationQueryStore();
      const read = () => store.readPage({
        incremental: true, scopeKey: "sqlite-audit", loadIndex: source.loadIndex,
        request: { protocol: 2, consumer: "main-sidebar", pageSize: 10, query: { kind: "lens", lens: "attention", attention: "active" } },
      });
      const work = { lists: 0, joined: 0, compact: 0, checkoutPaths: 0 };
      vi.spyOn(directoryStore, "readNavigationCheckouts").mockImplementation(async (paths) => {
        work.checkoutPaths += paths.length;
        return [];
      });
      vi.spyOn(StackReader.prototype, "read").mockResolvedValue({ stacks: [], catalogs: [] });
      const join = overlay.readNavigationQueryIndex.bind(overlay);
      vi.spyOn(overlay, "readNavigationQueryIndex").mockImplementation((args) => {
        work.lists++;
        work.joined += args.threads.length;
        return join(args);
      });
      const compactRows = overlay.readNavigationOverlayRows.bind(overlay);
      vi.spyOn(overlay, "readNavigationOverlayRows").mockImplementation((...args) => {
        const result = compactRows(...args);
        work.compact += result.length;
        return result;
      });
      const start = performance.now();
      await read();
      await source.waitForDiscovery();
      record({ kind: "sqlite", n, archived, phase: "cold", ms: performance.now() - start, ...work });
      for (const key of Object.keys(work)) work[key] = 0;
      const times = [];
      for (let i = 0; i < 12; i++) {
        const row = threads[i];
        row.threadStatus = "active";
        const start = performance.now();
        source.emit(row.source, "thread/status/changed", { threadId: row.id, status: { type: "active" } });
        let page = await read();
        for (let retry = 0; retry < 100 && page.counts.active !== i + 1; retry++) {
          await new Promise((resolve) => setImmediate(resolve));
          page = await read();
        }
        times.push(performance.now() - start);
        expect(page.counts.active).toBe(i + 1);
      }
      record({ kind: "sqlite", n, archived, phase: "warm", times, ...work });
    } finally {
      mocks.profileStore = undefined;
      vi.restoreAllMocks();
      db.close();
    }
  },
);
