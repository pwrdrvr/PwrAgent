import type { NavigationQueryPage, NavigationQueryRequest, FederationNavigationPageRequest, FederationNavigationPageResult } from "@pwragent/shared/contracts/navigation";
import { expandOwnerPage, hasNavigationPageRows, NavigationBaselineCache, ownerPageKey } from "./federation-navigation-page-deltas";

type Baseline = { page: NavigationQueryPage; token?: string };
type Load = (request: FederationNavigationPageRequest) => Promise<FederationNavigationPageResult>;

function acknowledgesCompletePage(wire: FederationNavigationPageResult, previous: NavigationQueryPage): boolean {
  return wire.unchanged === true && !wire.ownerPagePatch && !wire.remoteOwner && !wire.windowPagePatch
    && !wire.rangeUnchanged && wire.complete && !wire.nextCursor
    && hasNavigationPageRows(wire) && !wire.entries.length && !wire.directories?.length && !wire.modelGroups?.length
    && wire.protocol === 2 && wire.queryKey === previous.queryKey && wire.countsRevision === previous.countsRevision
    && wire.coverage?.state === "complete";
}

/** Owner-only baselines. Viewer overlays are reapplied after every owner read.
 * Never treat a renderer revision as proof of the cached owner's contents.
 */
export class RemoteNavigationPageBaselines {
  private readonly entries: NavigationBaselineCache<Baseline>;
  /** Shared only while reads for this key overlap. Evicting a page cannot erase their acceptance order. */
  private readonly pending = new Map<string, { active: number; issued: number; accepted: number }>();

  constructor(maxBytes = 8 * 1024 * 1024, maxEntries = 64) {
    this.entries = new NavigationBaselineCache(maxBytes, maxEntries);
  }

  async read(request: NavigationQueryRequest, load: Load, negotiated = false): Promise<NavigationQueryPage> {
    const { ownerPageBase: _peer, windowPageBase: _window, retainedRange, completeBaselineRevision: _revision,
      ...ownerRequest } = request as FederationNavigationPageRequest;
    const target = request.federationTarget;
    const key = ownerPageKey(target?.scope === "remote" ? target.instanceId : "", ownerRequest);
    const prior = this.entries.get(key);
    const eligible = !request.cursor && !request.anchor && !retainedRange;
    const revisionBase = eligible && !prior?.token ? prior?.page : undefined;
    const pending = this.pending.get(key) ?? { active: 0, issued: 0, accepted: 0 };
    this.pending.set(key, pending);
    pending.active++;
    const sequence = ++pending.issued;
    try {
      let wire = await load({ ...ownerRequest, completeBaselineRevision: revisionBase?.countsRevision,
        ...(negotiated ? { ownerPageBase: prior?.token ?? "" } : {}) });
      let page: NavigationQueryPage | undefined;
      if (wire?.unchanged || wire?.rangeUnchanged) {
        if (revisionBase && acknowledgesCompletePage(wire, revisionBase)
          && (!negotiated || wire.ownerEpoch === revisionBase.ownerEpoch)) {
          page = { ...revisionBase, ownerEpoch: wire.ownerEpoch, generation: wire.generation, coverage: wire.coverage, unchanged: false };
        } else if (!negotiated) {
          throw new Error("Remote navigation returned an invalid owner baseline.");
        }
      } else if (negotiated || !wire?.ownerPagePatch) {
        page = expandOwnerPage(wire, negotiated ? prior : undefined);
      }
      if (!page) {
        wire = await load(negotiated ? { ...ownerRequest, ownerPageBase: "" } : ownerRequest);
        page = negotiated || !wire?.ownerPagePatch ? expandOwnerPage(wire) : undefined;
        if (!page) throw new Error("Remote navigation did not return a fresh owner page.");
      }
      if (sequence > pending.accepted) {
        pending.accepted = sequence;
        const token = wire.ownerPagePatch?.token;
        if (token || (eligible && page.complete && (page.rangeStart ?? 0) === 0 && !page.nextCursor && page.coverage.state === "complete")) {
          // A compact revision acknowledgment can keep the already charged rows.
          if (!wire.unchanged || this.entries.get(key) !== prior) {
            const baseline = { page, token };
            this.entries.set(key, baseline, key.length + Buffer.byteLength(JSON.stringify(baseline)));
          }
        } else if (negotiated) {
          this.entries.delete(key);
        }
      }
      return page;
    } finally {
      if (--pending.active === 0) this.pending.delete(key);
    }
  }
}
