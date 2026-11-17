import type { NavigationThreadSummary } from "@pwragent/shared";
import { useLayoutEffect, useRef } from "react";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { createSubthreadTrays, ordinaryChildCountOf, type SubthreadTrays, type SubthreadTrayOptions } from "./subthread-trays";

type Scalar = string | number | boolean | undefined;
type Visit = (value: Scalar) => boolean;
type Inputs = {
  children: ReadonlyMap<string, NavigationThreadSummary[]>;
  owners: readonly NavigationThreadSummary[];
  ownerChildOrder: ReadonlyMap<string, readonly string[]>;
  options: SubthreadTrayOptions;
  threadsByKey: ReadonlyMap<string, NavigationThreadSummary>;
};

function visitRow(row: NavigationThreadSummary, options: SubthreadTrayOptions, visit: Visit): boolean {
  const ref = row.federation?.ref;
  if (!visit(row.id) || !visit(row.source) || !visit(ref?.backend) || !visit(ref?.threadId)
    || !visit(ref?.target.scope) || !visit(ref?.target.scope === "remote" ? ref.target.instanceId : undefined)
    || !visit(row.createdAt) || !visit(ordinaryChildCountOf(row))
    || !visit(Boolean(options.isCollapsed?.(row))) || !visit(row.subthreadOrder?.length ?? 0)) return false;
  for (const key of row.subthreadOrder ?? []) if (!visit(key)) return false;
  return true;
}

function visitInputs(params: Inputs, visit: Visit): boolean {
  if (!visit(params.owners.length)) return false;
  for (const owner of params.owners) if (!visitRow(owner, params.options, visit)) return false;
  if (!visit(params.children.size)) return false;
  for (const [parent, children] of params.children) {
    if (!visit(parent) || !visit(children.length)) return false;
    for (const child of children) if (!visitRow(child, params.options, visit)) return false;
  }
  if (!visit(params.ownerChildOrder.size)) return false;
  for (const [parent, keys] of params.ownerChildOrder) {
    if (!visit(parent) || !visit(keys.length)) return false;
    for (const key of keys) if (!visit(key)) return false;
  }
  if (!visit(params.options.draftParentKeys?.size ?? 0)) return false;
  for (const key of params.options.draftParentKeys ?? []) if (!visit(key)) return false;
  return true;
}

export type DirectoryTrayProjection = {
  inputs: Scalar[];
  subtrees: Map<string, string[]>;
  directChildren: Map<string, string[]>;
  depths: Map<string, number>;
  closingParents: Map<string, string[]>;
  folded: Set<string>;
  heldOpen: Set<string>;
};

export function projectDirectoryTrays(previous: DirectoryTrayProjection | undefined, params: Inputs): DirectoryTrayProjection {
  let index = 0;
  if (previous && visitInputs(params, (value) => previous.inputs[index++] === value)
    && index === previous.inputs.length) return previous;
  const inputs: Scalar[] = [];
  visitInputs(params, (value) => { inputs.push(value); return true; });
  const trays = createSubthreadTrays(params.children, params.owners, params.ownerChildOrder, params.options);
  const subtrees = new Map<string, string[]>();
  const directChildren = new Map<string, string[]>();
  const depths = new Map<string, number>();
  const closingParents = new Map<string, string[]>();
  const folded = new Set<string>();
  const heldOpen = new Set<string>();
  for (const owner of params.owners) {
    const key = threadSummaryIdentityKey(owner);
    subtrees.set(key, trays.subtree(key).map(threadSummaryIdentityKey));
    directChildren.set(key, trays.directChildKeys(key));
  }
  for (const rows of [params.owners, ...params.children.values()]) {
    for (const row of rows) {
      const key = threadSummaryIdentityKey(row);
      depths.set(key, trays.depth(key));
      const parents = trays.pagesAfter(key);
      if (parents.length) closingParents.set(key, parents.map(threadSummaryIdentityKey));
      if (trays.folded(key)) folded.add(key);
      if (trays.heldOpen(key)) heldOpen.add(key);
    }
  }
  return { inputs, subtrees, directChildren, depths, closingParents, folded, heldOpen };
}

const NO_KEYS: string[] = [];

export function readDirectoryTrays(
  plan: DirectoryTrayProjection,
  rows: ReadonlyMap<string, NavigationThreadSummary>,
): SubthreadTrays & { hasInSubtree: (trayKey: string, threadKey: string) => boolean } {
  const current = (keys: readonly string[]): NavigationThreadSummary[] => keys
    .map((key) => rows.get(key)).filter((row): row is NavigationThreadSummary => Boolean(row));
  return {
    subtree: (key) => current(plan.subtrees.get(key) ?? NO_KEYS),
    directChildKeys: (key) => plan.directChildren.get(key) ?? NO_KEYS,
    depth: (key) => plan.depths.get(key) ?? 1,
    pagesAfter: (key) => current(plan.closingParents.get(key) ?? NO_KEYS),
    folded: (key) => plan.folded.has(key),
    heldOpen: (key) => plan.heldOpen.has(key),
    hasInSubtree: (tray, key) => plan.subtrees.get(tray)?.includes(key) ?? false,
  };
}

/** Current rendered directories only; discarded renders cannot publish plans. */
export function useDirectoryTrays(): (directoryKey: string, params: Inputs) => ReturnType<typeof readDirectoryTrays> {
  const committed = useRef(new Map<string, DirectoryTrayProjection>());
  const next = new Map<string, DirectoryTrayProjection>();
  useLayoutEffect(() => { committed.current = next; });
  return (directoryKey, params) => {
    const projection = projectDirectoryTrays(committed.current.get(directoryKey), params);
    next.set(directoryKey, projection);
    return readDirectoryTrays(projection, params.threadsByKey);
  };
}
