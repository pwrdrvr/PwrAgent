import type { NavigationQueryPage } from "./contracts/navigation";
import { buildFederatedThreadRef } from "./contracts/federation";

/**
 * What a viewer adds to a page another instance owns.
 *
 * An owner fills a page up to the result budget. The viewer knows facts the
 * owner does not: the owner's label, status and icon, the capabilities it
 * granted, and this viewer's own directory disclosure. Those facts are the
 * same for every row of the page, so they travel once, in `remoteOwner`, and
 * the owner's rows travel unchanged. A page therefore costs its viewer what
 * it cost its owner, and a page the owner could select is one the viewer can
 * hold.
 *
 * Rows are filled in from the block where they are used
 * (`expandNavigationRemoteOwner`). The budget is measured without the block
 * and without what it filled in (`navigationQueryPageBudgetBytes`).
 */

/** The most a viewer's block may hold, separate from the owner's page budget. */
export const NAVIGATION_REMOTE_OWNER_MAX_BYTES = 32 * 1024;

// Node, Electron and browsers all provide it. This package compiles without
// their library types, so it is named here.
declare const TextEncoder: new () => { encode(text: string): { byteLength: number } };

/** UTF-8 length of the JSON: one serialization and one encode per page. */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Bytes of the viewer's block. Zero for a page this instance owns. */
export function navigationRemoteOwnerBytes(page: NavigationQueryPage): number {
  return page.remoteOwner ? jsonBytes(page.remoteOwner) : 0;
}

/**
 * Fill each row with its owner's identity and the viewer's facts.
 *
 * A row another owner already claims keeps that owner. The result keeps
 * `remoteOwner`, so the budget can still be measured on it.
 */
export function expandNavigationRemoteOwner(page: NavigationQueryPage): NavigationQueryPage {
  const owner = page.remoteOwner;
  if (!owner) return page;
  const collapsed = owner.directoryThreadsCollapsed;
  const disclose = <T extends { key: string; directoryThreadsCollapsed?: boolean }>(directory: T): T =>
    collapsed && Object.hasOwn(collapsed, directory.key)
      ? { ...directory, directoryThreadsCollapsed: collapsed[directory.key] }
      : directory;
  return {
    ...page,
    ...(page.directories ? { directories: page.directories.map(disclose) } : {}),
    ...(page.selectionDirectory ? { selectionDirectory: disclose(page.selectionDirectory) } : {}),
    entries: page.entries.map((entry) => {
      const placement = entry.placement.kind === "child"
        && !entry.placement.parent.ownerInstanceId
        ? { ...entry.placement, parent: {
          ...entry.placement.parent, ownerInstanceId: owner.instanceId,
        } }
        : entry.placement;
      if (entry.row.ref.ownerInstanceId && entry.row.ref.ownerInstanceId !== owner.instanceId) {
        return placement === entry.placement ? entry : { ...entry, placement };
      }
      const ref = buildFederatedThreadRef({
        backend: entry.row.source,
        instanceId: owner.instanceId,
        threadId: entry.row.id,
      });
      return {
        ...entry,
        placement,
        row: {
          ...entry.row,
          ref: {
            ...entry.row.ref,
            ownerInstanceId: owner.instanceId,
          },
          federation: {
            ...entry.row.federation,
            instanceLabel: owner.instanceLabel,
            ref,
            // One array for the whole page: a filled row costs no copy of it.
            ...(owner.capabilities ? { capabilities: owner.capabilities } : {}),
            ...(owner.peerStatus ? { peerStatus: owner.peerStatus } : {}),
            celestialIcon: owner.celestialIcon,
          },
        },
      };
    }),
  };
}

/**
 * Bytes this page counts against the result budget: the owner's own content.
 *
 * For a page this instance owns, that is the whole page. For another owner's
 * page it leaves out the viewer's block and everything filled in from it, so
 * the answer is the same before and after `expandNavigationRemoteOwner`. It
 * is never more than the bytes the owner measured. It is less only by the
 * disclosure values the viewer replaces, which cannot be told apart from the
 * owner's once rows are filled in.
 */
export function navigationQueryPageBudgetBytes(page: NavigationQueryPage): number {
  const owner = page.remoteOwner;
  if (!owner) return jsonBytes(page);
  const collapsed = owner.directoryThreadsCollapsed;
  const undisclose = <T extends { key: string; directoryThreadsCollapsed?: boolean }>(directory: T): T => {
    if (!collapsed || !Object.hasOwn(collapsed, directory.key)) return directory;
    const { directoryThreadsCollapsed: _viewer, ...rest } = directory;
    return rest as T;
  };
  const { remoteOwner: _block, ...content } = page;
  return jsonBytes({
    ...content,
    ...(page.directories ? { directories: page.directories.map(undisclose) } : {}),
    ...(page.selectionDirectory ? { selectionDirectory: undisclose(page.selectionDirectory) } : {}),
    entries: page.entries.map((entry) => {
      const federation = entry.row.federation;
      const filled = federation?.ref.target.scope === "remote"
        && federation.ref.target.instanceId === owner.instanceId;
      const parentFilled = entry.placement.kind === "child"
        && entry.placement.parent.ownerInstanceId === owner.instanceId;
      if (!filled && !parentFilled) return entry;
      const placement = parentFilled && entry.placement.kind === "child"
        ? { ...entry.placement, parent: { ...entry.placement.parent, ownerInstanceId: undefined } }
        : entry.placement;
      if (!filled) return { ...entry, placement };
      const { federation: _federation, ...row } = entry.row;
      return { ...entry, placement, row: { ...row, ref: { ...row.ref, ownerInstanceId: undefined } } };
    }),
  });
}
