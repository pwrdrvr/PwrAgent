import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { navigationQueryKey } from "../app-server/navigation-query-projection";

/** Owner-only baselines. Viewer overlays are reapplied after every owner read.
 * Never treat a renderer revision as proof of the cached owner's contents.
 */
export class RemoteNavigationPageBaselines {
  private readonly entries = new Map<string, { page: NavigationQueryPage; bytes: number }>();
  constructor(private readonly maxBytes = 8 * 1024 * 1024, private readonly maxEntries = 64) {}

  async read(request: NavigationQueryRequest, load: (request: NavigationQueryRequest) => Promise<NavigationQueryPage>): Promise<NavigationQueryPage> {
    const key = JSON.stringify([request.federationTarget, navigationQueryKey(request), request.pageSize]);
    const eligible = !request.cursor && !request.anchor && !request.retainedRange;
    const baseline = eligible ? this.entries.get(key) : undefined;
    const page = await load({ ...request, completeBaselineRevision: baseline?.page.countsRevision,
      // A range acknowledgment also omits directory disclosure. Only locally
      // retained owner pages can be expanded before applying viewer overlays.
      retainedRange: undefined });
    if (page.unchanged || page.rangeUnchanged) {
      if (!baseline || page.rangeUnchanged || !page.complete || page.nextCursor || page.entries.length
        || page.directories?.length || page.modelGroups?.length || page.protocol !== 2
        || page.queryKey !== baseline.page.queryKey || page.countsRevision !== baseline.page.countsRevision
        || page.coverage.state !== "complete") throw new Error("Remote navigation returned an invalid owner baseline.");
      return { ...baseline.page, ownerEpoch: page.ownerEpoch, generation: page.generation,
        coverage: page.coverage, unchanged: false };
    }
    if (eligible && page.complete && (page.rangeStart ?? 0) === 0 && !page.nextCursor && page.coverage.state === "complete") {
      const bytes = Buffer.byteLength(JSON.stringify(page));
      this.entries.delete(key);
      if (bytes <= this.maxBytes) this.entries.set(key, { page, bytes });
      let retainedBytes = [...this.entries.values()].reduce((sum, value) => sum + value.bytes, 0);
      for (const [oldKey, old] of this.entries) {
        if (retainedBytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
        this.entries.delete(oldKey);
        retainedBytes -= old.bytes;
      }
    }
    return page;
  }
}
