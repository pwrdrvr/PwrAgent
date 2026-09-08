import { Session } from "node:inspector";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildFederatedThreadRef, type AppServerThreadSummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { NavigationIndexReadPool } from "../app-server/navigation-index-read-pool";
import { NavigationQueryStore } from "../app-server/navigation-query-store";

it.each([1, 5, 15])("bounds physical SQLite scans across %i project refreshes", async (projects) => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const threads: AppServerThreadSummary[] = Array.from({ length: 1200 }, (_, i) => ({
    id: `thread-${i}`, source: "codex", title: `Thread ${i}`, titleSource: "explicit", updatedAt: i,
    linkedDirectories: [{ id: `/repos/project-${i % 15}`, path: `/repos/project-${i % 15}`, label: `project-${i % 15}`, kind: "local" }],
  }));
  try {
    for (let i = 0; i < 100; i++) {
      db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run(`codex:parent-${i}`, JSON.stringify({
        backend: "codex", threadId: `parent-${i}`, subAgents: [{ monitorThreadId: `child-${i}` }],
        immutableUsageActivities: [{ text: "history ".repeat(2000) }],
      }));
    }
    for (let i = 0; i < 50; i++) await store.addRemoteThreadPin({
      ref: buildFederatedThreadRef({ backend: "codex", threadId: `pin-${i}`, instanceId: "peer" }), instanceLabel: "Peer",
      summary: { ...threads[i]!, id: `pin-${i}`, inbox: { inInbox: false } },
    });
    for (const reuse of [false, true]) {
      const pool = new NavigationIndexReadPool(reuse ? 1_000 : 0);
      const queries = new NavigationQueryStore();
      store["remotePinNavigationCache"] = undefined;
      const physical = vi.spyOn(store, "readNavigationQueryIndex");
      const prepare = vi.spyOn(db.raw, "prepare");
      const profilePath = process.env.PWRAGENT_NAVIGATION_CPU_PROFILE;
      const session = profilePath && projects === 15 ? new Session() : undefined;
      session?.connect();
      const post = session ? (method: string): Promise<unknown> => new Promise((resolve, reject) => {
        session.post(method, (error, result) => error ? reject(error) : resolve(result));
      }) : undefined;
      if (post) { await post("Profiler.enable"); await post("Profiler.start"); }
      const loadIndex = async () => {
        const index = await pool.read(store.readNavigationSourceVersion(), async () => ({
          ...store.readNavigationQueryIndex({ backend: "all", threads }), inputRequestThreadKeys: new Set<string>(),
        }));
        // The uncached control models the former viewer projection on every
        // query. The optimized phase uses the production version/TTL checks.
        if (!reuse) store["remotePinNavigationCache"] = undefined;
        const pins = await store.readRemoteThreadPinNavigationRows();
        return { ...index, threads: [...index.threads, ...pins] };
      };
      for (let project = 0; project < projects; project++) {
        const page = await queries.readPage({ loadIndex, scopeKey: "viewer", request: {
          protocol: 2, consumer: "star-map", pageSize: 10,
          query: { kind: "star-map", projectKey: `directory:/repos/project-${project}`, filters: {} },
        } });
        expect(page.entries).toHaveLength(10);
      }
      if (post) {
        const result = await post("Profiler.stop") as { profile: unknown };
        writeFileSync(`${profilePath}-${reuse ? "reuse" : "uncached"}.cpuprofile`, JSON.stringify(result.profile));
        session!.disconnect();
      }
      expect(physical).toHaveBeenCalledTimes(reuse ? 1 : projects);
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("WITH pins AS"))).toHaveLength(reuse ? 1 : projects);
      physical.mockRestore(); prepare.mockRestore();
    }
  } finally { db.close(); }
});
