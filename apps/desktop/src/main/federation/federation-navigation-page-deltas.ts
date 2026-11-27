import { createHash, randomUUID } from "node:crypto";
import { navigationQueryKey } from "@pwragent/owner-core/navigation-query-projection";
import {
  NAVIGATION_QUERY_MAX_PAGE_ROWS,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  type FederationNavigationPagePatch,
  type FederationNavigationPageRequest,
  type FederationNavigationPageResult,
  type NavigationQueryPage,
  type NavigationQueryRequest,
} from "@pwragent/shared/contracts/navigation";
import { navigationPageFingerprints, navigationPageSlots, type PageFingerprints } from "../navigation-page-slots";

export function ownerPageKey(ownerOrRequester: string, request: NavigationQueryRequest): string {
  return createHash("sha256").update(JSON.stringify([ownerOrRequester, request.consumer, navigationQueryKey(request),
    request.pageSize, request.cursor, request.anchor, request.readReason === "pins"])).digest("base64url");
}

export class NavigationBaselineCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxBytes: number, private readonly maxEntries: number) {}

  get(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  delete(key: string): void {
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.bytes;
      this.entries.delete(key);
    }
  }

  set(key: string, value: T, bytes: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      this.delete(this.entries.keys().next().value!);
    }
  }
}

function collection(page: NavigationQueryPage) {
  return page.modelGroups ? "modelGroups" : page.directories && !page.entries.length ? "directories" : "entries";
}

type OwnerBaseline = PageFingerprints & {
  token: string;
  scope: string;
  connection: WeakRef<object>;
};

/** Fingerprints only. Every read still runs the authorized owner projection, including cursor validation. */
export class FederationNavigationPageDeltas {
  private readonly baselines = new NavigationBaselineCache<OwnerBaseline>(1024 * 1024, 128);

  encode(
    requester: string, connection: object, request: FederationNavigationPageRequest, page: NavigationQueryPage,
  ): FederationNavigationPageResult {
    const key = ownerPageKey(requester, request);
    const kind = collection(page);
    const scope = JSON.stringify([page.ownerEpoch, page.queryKey, page.rangeStart ?? 0, kind]);
    const prior = this.baselines.get(key);
    const current = navigationPageFingerprints(page);
    const token = randomUUID();
    let result: FederationNavigationPageResult = { ...page, ownerPagePatch: { token } };
    if (prior && prior.connection.deref() === connection && prior.scope === scope && prior.token === request.ownerPageBase) {
      const { slots, orderKeys } = navigationPageSlots(prior, current);
      const changes = Object.fromEntries(slots.flatMap((slot, i) => slot === i ? [] : [[i, slot]]));
      const patch: FederationNavigationPagePatch = { token, base: prior.token,
        ...(slots.length !== prior.hashes.length ? { length: slots.length } : {}),
        ...(Object.keys(changes).length ? { slots: changes } : {}),
        ...(Object.keys(orderKeys).length ? { orderKeys } : {}),
      };
      // A full replacement already records every new position.
      if (!slots.length || slots.some(slot => slot >= 0)) {
        result = { ...page, [kind]: page[kind]!.filter((_, i) => slots[i] === -1), ownerPagePatch: patch };
      }
    }
    if (Buffer.byteLength(JSON.stringify(result)) > NAVIGATION_QUERY_MAX_RESULT_BYTES) return page;
    const baseline = { ...current, token, scope, connection: new WeakRef(connection) };
    this.baselines.set(key, baseline, Buffer.byteLength(JSON.stringify(baseline)) + key.length);
    return result;
  }
}

function validPosition(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

export function expandOwnerPage(
  wire: FederationNavigationPageResult,
  baseline?: { token?: string; page: NavigationQueryPage },
): NavigationQueryPage | undefined {
  const { ownerPagePatch: patch, ...page } = wire;
  if (page.protocol !== 2 || page.windowPagePatch || page.remoteOwner || page.unchanged || page.rangeUnchanged) return undefined;
  if (!patch) return page;
  if (typeof patch.token !== "string" || !patch.token.length || patch.token.length > 128) return undefined;
  if (patch.base === undefined) return patch.slots || patch.orderKeys || patch.length !== undefined ? undefined : page;
  if (!baseline || patch.base !== baseline.token || page.ownerEpoch !== baseline.page.ownerEpoch
    || page.queryKey !== baseline.page.queryKey || (page.rangeStart ?? 0) !== (baseline.page.rangeStart ?? 0)) return undefined;
  // Patched entries can be empty. The original page determines their collection type.
  const kind = collection(baseline.page);
  if (kind !== collection(page)) return undefined;
  const prior = baseline.page[kind]!;
  const changed = page[kind]!;
  const length = patch.length ?? prior.length;
  if (!Number.isInteger(length) || length < 0 || length > NAVIGATION_QUERY_MAX_PAGE_ROWS) return undefined;
  if (Object.keys(patch.slots ?? {}).some(key => !validPosition(key, length))) return undefined;
  const used = new Set<number>();
  const rows = [];
  let next = 0;
  for (let i = 0; i < length; i++) {
    const slot = patch.slots && Object.hasOwn(patch.slots, i) ? patch.slots[i] : i;
    if (slot === undefined || used.has(slot)) return undefined;
    if (slot !== -1) used.add(slot);
    const row = slot === -1 ? changed[next++] : Number.isInteger(slot) && slot >= 0 ? prior[slot] : undefined;
    if (!row) return undefined;
    rows.push(row);
  }
  if (next !== changed.length) return undefined;
  for (const [key, orderKey] of Object.entries(patch.orderKeys ?? {})) {
    if (kind !== "entries" || !validPosition(key, length) || typeof orderKey !== "string") return undefined;
    rows[Number(key)] = { ...rows[Number(key)]!, orderKey };
  }
  const expanded = { ...page, [kind]: rows };
  return Buffer.byteLength(JSON.stringify(expanded)) <= NAVIGATION_QUERY_MAX_RESULT_BYTES ? expanded : undefined;
}
