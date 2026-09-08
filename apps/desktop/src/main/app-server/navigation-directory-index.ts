import { randomUUID } from "node:crypto";
import type { NavigationDirectoryRow, NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { getDesktopNavigationQueryPool } from "./navigation-query-pool";
import { getDesktopNavigationQueryStore, NavigationQueryError } from "./navigation-query-store";
import { loadLocalNavigationQueryIndex } from "./navigation-query-source";

const MAX_DIRECTORY_INDEX_BYTES = 8 * 1024 * 1024;

/** Complete compact directory metadata for an explicit owner-local operation. */
export async function readLocalNavigationDirectoryIndex(): Promise<NavigationDirectoryRow[]> {
  const pool = getDesktopNavigationQueryPool();
  const store = getDesktopNavigationQueryStore();
  const consumerId = `owner-directory-index:${randomUUID()}`;
  const deadlineAt = Date.now() + 10_000;
  try {
    for (let restart = 0; restart < 2; restart += 1) {
      const directories = new Map<string, NavigationDirectoryRow>();
      const cursors = new Set<string>();
      let previous: NavigationQueryPage | undefined;
      let bytes = 0;
      try {
        do {
          if (Date.now() >= deadlineAt) throw new Error("Directory inventory read deadline expired.");
          const request: NavigationQueryRequest = {
            protocol: 2, consumer: "star-map", query: { kind: "directory-index" }, pageSize: 100,
            cursor: previous?.nextCursor, deadlineAt,
          };
          const page = await pool.read({ consumerId, request, load: async ({ signal }) => {
            signal.throwIfAborted();
            return store.readPage({ request, scopeKey: "renderer-local", loadIndex: async () => {
              const index = await loadLocalNavigationQueryIndex({ callerReason: "owner-directory-index" });
              signal.throwIfAborted();
              return index;
            } });
          } });
          if (page.protocol !== 2 || page.unchanged || page.coverage.state !== "complete"
            || page.complete === Boolean(page.nextCursor)
            || (previous && (previous.generation !== page.generation || previous.ownerEpoch !== page.ownerEpoch
              || previous.queryKey !== page.queryKey || previous.countsRevision !== page.countsRevision))) {
            throw new Error("Directory inventory has no complete matching owner generation.");
          }
          bytes += Buffer.byteLength(JSON.stringify(page));
          if (bytes > MAX_DIRECTORY_INDEX_BYTES) throw new Error("Directory inventory exceeds its metadata budget.");
          for (const directory of page.directories ?? []) directories.set(directory.key, directory);
          if (page.complete) return [...directories.values()];
          if (cursors.has(page.nextCursor!)) throw new Error("Directory inventory cursor did not advance.");
          cursors.add(page.nextCursor!);
          previous = page;
        } while (previous.nextCursor);
      } catch (error) {
        if (restart === 0 && error instanceof NavigationQueryError && error.code === "navigation_cursor_expired") continue;
        throw error;
      }
    }
    throw new Error("Directory inventory could not establish a complete baseline.");
  } finally { pool.release(consumerId); }
}
