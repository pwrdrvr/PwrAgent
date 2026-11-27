import { createHash, randomUUID } from "node:crypto";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES, type NavigationQueryPage } from "@pwragent/shared/contracts/navigation";
import { navigationQueryPageBudgetBytes } from "@pwragent/shared/navigation-remote-owner";
import { navigationPageFingerprints, navigationPageSlots, type PageFingerprints } from "../navigation-page-slots";

type Baseline = PageFingerprints & { scope: string; token: string };

/** The owner keeps fingerprints only. A missed response, eviction or owner restart sends a fresh page. */
export class NavigationWindowPageDeltas {
  private readonly baselines = new Map<string, Baseline>();

  encode(consumer: string, base: string, page: NavigationQueryPage): NavigationQueryPage {
    if (page.unchanged || page.rangeUnchanged) return page;
    const directories = Boolean(page.directories?.length && !page.entries.length);
    const collection = directories ? page.directories! : page.entries;
    if (!collection.length) return page;
    // Filled rows share the viewer's owner label, capabilities and disclosure
    // preferences. A change to that block invalidates every filled row.
    const scope = createHash("sha256").update(JSON.stringify([page.ownerEpoch, page.queryKey, page.remoteOwner, directories])).digest("base64url");
    const prior = this.baselines.get(consumer);
    const fingerprints = navigationPageFingerprints(page);
    const token = randomUUID();
    let result: NavigationQueryPage = { ...page, windowPagePatch: { token } };
    if (base && prior?.scope === scope && prior.token === base) {
      const { slots, orderKeys } = navigationPageSlots(prior, fingerprints);
      if (slots.some((slot) => slot >= 0)) {
        const changed = (_: unknown, position: number) => slots[position] === -1;
        result = { ...page, ...(directories ? { directories: page.directories!.filter(changed) } : { entries: page.entries.filter(changed) }),
          windowPagePatch: { token, base, slots, ...(directories ? { directories: true } : {}),
            ...(Object.keys(orderKeys).length ? { orderKeys } : {}) } };
      }
    }
    if (page.remoteOwner) result.windowPagePatch!.ownerContentBytes = navigationQueryPageBudgetBytes(page);
    if (Buffer.byteLength(JSON.stringify(result)) > NAVIGATION_QUERY_MAX_RESULT_BYTES) return page;
    this.baselines.delete(consumer);
    if (this.baselines.size >= 128) this.baselines.delete(this.baselines.keys().next().value!);
    this.baselines.set(consumer, { token, scope, ...fingerprints });
    return result;
  }
}
