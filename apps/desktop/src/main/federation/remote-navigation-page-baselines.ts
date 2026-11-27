import type { NavigationQueryPage, NavigationQueryRequest, FederationNavigationPageRequest, FederationNavigationPageResult } from "@pwragent/shared/contracts/navigation";
import { expandOwnerPage, NavigationBaselineCache, ownerPageKey } from "./federation-navigation-page-deltas";

type Baseline = { page: NavigationQueryPage; token?: string };
type Load = (request: FederationNavigationPageRequest) => Promise<FederationNavigationPageResult>;

/** Owner-only baselines. Viewer overlays are reapplied after every owner read.
 * Never treat a renderer revision as proof of the cached owner's contents.
 */
export class RemoteNavigationPageBaselines {
  private readonly entries: NavigationBaselineCache<Baseline>;

  constructor(maxBytes = 8 * 1024 * 1024, maxEntries = 64) {
    this.entries = new NavigationBaselineCache(maxBytes, maxEntries);
  }

  async read(request: NavigationQueryRequest, load: Load, negotiated = false): Promise<NavigationQueryPage> {
    const { ownerPageBase: _peer, windowPageBase: _window, retainedRange, completeBaselineRevision: _revision,
      ...ownerRequest } = request as FederationNavigationPageRequest;
    const target = request.federationTarget;
    const key = ownerPageKey(target?.scope === "remote" ? target.instanceId : "", ownerRequest);
    const prior = this.entries.get(key);
    if (negotiated) {
      const baseline = prior?.token ? prior : undefined;
      const wire = await load({ ...ownerRequest, ownerPageBase: baseline?.token ?? "" });
      let page = expandOwnerPage(wire, baseline);
      let token = wire.ownerPagePatch?.token;
      if (!page) {
        const fresh = await load({ ...ownerRequest, ownerPageBase: "" });
        page = expandOwnerPage(fresh);
        if (!page) throw new Error("Remote navigation did not return a fresh owner page.");
        token = fresh.ownerPagePatch?.token;
      }
      // Concurrent reads each decode against what they asked for. A late reply
      // cannot install its predecessor over another read's accepted baseline.
      if (this.entries.get(key) === prior) {
        if (token) this.remember(key, { token, page });
        else this.entries.delete(key);
      }
      return page;
    }
    const eligible = !request.cursor && !request.anchor && !retainedRange;
    const baseline = eligible && !prior?.token ? prior : undefined;
    const page = await load({ ...ownerRequest, completeBaselineRevision: baseline?.page.countsRevision });
    if (page.ownerPagePatch) {
      const fresh = await load(ownerRequest);
      if (fresh.ownerPagePatch || fresh.unchanged || fresh.rangeUnchanged) throw new Error("Remote navigation did not return a fresh owner page.");
      return fresh;
    }
    if (page.unchanged || page.rangeUnchanged) {
      if (!baseline || page.rangeUnchanged || !page.complete || page.nextCursor || page.entries.length
        || page.directories?.length || page.modelGroups?.length || page.protocol !== 2
        || page.queryKey !== baseline.page.queryKey || page.countsRevision !== baseline.page.countsRevision
        || page.coverage.state !== "complete") throw new Error("Remote navigation returned an invalid owner baseline.");
      return { ...baseline.page, ownerEpoch: page.ownerEpoch, generation: page.generation,
        coverage: page.coverage, unchanged: false };
    }
    if (eligible && page.complete && (page.rangeStart ?? 0) === 0 && !page.nextCursor && page.coverage.state === "complete") {
      this.remember(key, { page });
    }
    return page;
  }

  private remember(key: string, baseline: Baseline): void {
    this.entries.set(key, baseline, key.length + Buffer.byteLength(JSON.stringify(baseline)));
  }
}
