import type { NavigationQueryEntry, NavigationThreadSummary } from "@pwragent/shared";
import { useLayoutEffect, useRef } from "react";
import type { NavigationPresentedThread } from "../../lib/navigation-loaded-rows";
import { navigationThreadSelectionKey } from "../../lib/navigation-query-state";
import {
  buildPagedDirectoryChildKeys,
  type DirectoryChildren,
  type PagedDirectoryChildInputs,
  type PagedDirectoryChildren,
} from "./paged-directory-presentation";

type Scalar = string | number | undefined;
type Visit = (value: Scalar) => boolean;
type Ref = NavigationQueryEntry["row"]["ref"];
const NO_ROWS: NavigationThreadSummary[] = [];

function visitRef(ref: Ref, visit: Visit): boolean {
  return visit(ref.backend) && visit(ref.threadId) && visit(ref.ownerInstanceId);
}

function visitPlacement(entry: Pick<NavigationQueryEntry, "placement" | "siblingOrder">, visit: Visit): boolean {
  return visit(entry.placement.kind)
    && (entry.placement.kind !== "child" || visitRef(entry.placement.parent, visit))
    && visit(entry.siblingOrder);
}

/** Only fields consumed by child membership, counts and owner sibling order. */
function visitInputs(params: PagedDirectoryChildInputs & { threadsByKey: ReadonlyMap<string, NavigationPresentedThread> }, visit: Visit): boolean {
  if (!visit(params.resources.size) || !visit(params.presentationOrder ? "supplied" : "page")) return false;
  for (const resource of params.resources.values()) {
    const { request, page } = resource.state;
    const query = request.query;
    if (!visit(resource.id) || !visit(query.kind)) return false;
    if (query.kind === "children") {
      if (!visit(query.directoryKey) || !visitRef(query.parent, visit)) return false;
    }
    if (query.kind === "exact") {
      if (!visit(request.inventory)
        || !visit(request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : undefined)) return false;
    }
    const visitOwnerPosition = (key: string): boolean => {
      if (!(query.kind === "children" && query.directoryKey !== undefined)
        && !(query.kind === "exact" && request.inventory === "owner")) return true;
      const row = params.threadsByKey.get(key);
      const owner = row?.federation?.ref.target;
      return visit(row?.ownerSiblingPosition === undefined ? "unknown" : "observed")
        && visit(row?.ownerSiblingPosition?.parentKey) && visit(row?.ownerSiblingPosition?.position)
        && visit(owner?.scope) && visit(owner?.scope === "remote" ? owner.instanceId : undefined)
        && visit(row?.source) && visit(row?.parentThreadId) && visit(row?.parentThreadBackend) && visit(row?.parentThreadInstanceId);
    };
    if (query.kind === "children" && query.directoryKey !== undefined) {
      const entries = page?.entries ?? [];
      if (!visit(entries.length)) return false;
      for (const { row } of entries) {
        if (!visitRef(row.ref, visit) || !visit(row.ordinaryChildCount)) return false;
      }
    }
    if (params.presentationOrder) {
      const entries = params.presentationOrder.get(resource.id) ?? [];
      if (!visit(entries.length)) return false;
      for (const entry of entries) {
        if (!visit(entry.key) || !visitPlacement(entry, visit) || !visitOwnerPosition(entry.key)) return false;
      }
    } else {
      const entries = page?.entries ?? [];
      if (!visit(entries.length)) return false;
      for (const entry of entries) {
        if (!visitRef(entry.row.ref, visit) || !visitPlacement(entry, visit)
          || !visitOwnerPosition(navigationThreadSelectionKey(entry.row.ref))) return false;
      }
    }
  }
  return true;
}

function currentRows(
  keys: readonly string[],
  threads: ReadonlyMap<string, NavigationThreadSummary>,
  previous: NavigationThreadSummary[] | undefined,
): NavigationThreadSummary[] {
  const old = previous ?? NO_ROWS;
  let rows = old;
  let changed = false;
  let index = 0;
  for (const key of keys) {
    const row = threads.get(key);
    if (!row) continue;
    if (!changed && old[index] !== row) { rows = old.slice(0, index); changed = true; }
    if (changed) rows.push(row);
    index++;
  }
  return !changed && old.length !== index ? old.slice(0, index) : rows;
}

function hydrate(
  keys: Map<string, DirectoryChildren<string>>,
  threads: ReadonlyMap<string, NavigationThreadSummary>,
  previous: PagedDirectoryChildren | undefined,
): PagedDirectoryChildren {
  let result = previous;
  let copied = false;
  for (const [directoryKey, directory] of keys) {
    const old = previous?.get(directoryKey);
    const samePlan = old?.ownerChildOrder === directory.ownerChildOrder && old.ordinaryChildCounts === directory.ordinaryChildCounts;
    let buckets = samePlan ? old!.childThreadsByParentKey : new Map<string, NavigationThreadSummary[]>();
    let same = samePlan;
    for (const [parent, childKeys] of directory.childThreadsByParentKey) {
      const rows = currentRows(childKeys, threads, old?.childThreadsByParentKey.get(parent));
      const previousRows = old?.childThreadsByParentKey.get(parent);
      if (samePlan && (rows === previousRows || (!rows.length && !previousRows))) continue;
      if (same) { buckets = new Map(buckets); same = false; }
      if (rows.length) buckets.set(parent, rows);
      else buckets.delete(parent);
    }
    if (same) continue;
    if (!copied) { result = new Map(previous); copied = true; }
    result!.set(directoryKey, { ...directory, childThreadsByParentKey: buckets });
  }
  for (const key of previous?.keys() ?? []) {
    if (keys.has(key)) continue;
    if (!copied) { result = new Map(previous); copied = true; }
    result!.delete(key);
  }
  return result ?? new Map();
}

export type PagedDirectoryChildrenProjection = {
  inputs: Scalar[];
  keys: Map<string, DirectoryChildren<string>>;
  admissionKeys: string[];
  admitted: boolean[];
  children: PagedDirectoryChildren;
};

export function projectPagedDirectoryChildren(
  previous: PagedDirectoryChildrenProjection | undefined,
  params: PagedDirectoryChildInputs & { threadsByKey: ReadonlyMap<string, NavigationThreadSummary> },
): PagedDirectoryChildrenProjection {
  let index = 0;
  // Availability affects first-admitted bucket order as well as membership.
  // Keep missing candidates so their eventual admission invalidates the plan.
  const same = previous && visitInputs(params, (value) => previous.inputs[index++] === value)
    && previous.admissionKeys.every((key, slot) => params.threadsByKey.has(key) === previous.admitted[slot])
    && index === previous.inputs.length;
  let inputs = previous?.inputs;
  let keys = previous?.keys;
  let admissionKeys = previous?.admissionKeys;
  let admitted = previous?.admitted;
  if (!same) {
    inputs = [];
    visitInputs(params, (value) => { inputs!.push(value); return true; });
    const built = buildPagedDirectoryChildKeys(params);
    keys = built.directories;
    admissionKeys = built.admissionKeys;
    admitted = admissionKeys.map((key) => params.threadsByKey.has(key));
  }
  const children = hydrate(keys!, params.threadsByKey, previous?.children);
  return same && children === previous!.children ? previous! : {
    inputs: inputs!, keys: keys!, admissionKeys: admissionKeys!, admitted: admitted!, children,
  };
}

/** One committed window projection; current row objects never live in a membership plan. */
export function usePagedDirectoryChildren(
  params: PagedDirectoryChildInputs & { threadsByKey: ReadonlyMap<string, NavigationThreadSummary> },
): PagedDirectoryChildren {
  const cache = useRef<PagedDirectoryChildrenProjection | undefined>(undefined);
  const next = projectPagedDirectoryChildren(cache.current, params);
  useLayoutEffect(() => { cache.current = next; }, [next]);
  return next.children;
}
