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
 * (`expandNavigationRemoteOwner`). The budget is the size of the owner's
 * content as it arrived, which filling in records on the block
 * (`navigationQueryPageBudgetBytes`).
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
 * `remoteOwner` and records on it what the owner's content measured, because
 * that cannot be recovered once rows are filled in. A page that carries the
 * record is already filled in and is returned as it is.
 */
export function expandNavigationRemoteOwner(page: NavigationQueryPage): NavigationQueryPage {
  if (!page.remoteOwner || page.remoteOwner.ownerContentBytes !== undefined) return page;
  const owner = { ...page.remoteOwner, ownerContentBytes: page.windowPagePatch?.ownerContentBytes ?? navigationQueryPageBudgetBytes(page) };
  const collapsed = owner.directoryThreadsCollapsed;
  const disclose = <T extends { key: string; directoryThreadsCollapsed?: boolean }>(directory: T): T =>
    collapsed && Object.hasOwn(collapsed, directory.key)
      ? { ...directory, directoryThreadsCollapsed: collapsed[directory.key] }
      : directory;
  return {
    ...page,
    remoteOwner: owner,
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
 * page it is the page without the viewer's block, measured as it arrived:
 * exactly what its owner measured. Once rows are filled in, it is the
 * measurement taken at that moment.
 */
export function navigationQueryPageBudgetBytes(page: NavigationQueryPage): number {
  if (!page.remoteOwner) return jsonBytes(page);
  if (page.remoteOwner.ownerContentBytes !== undefined) return page.remoteOwner.ownerContentBytes;
  const { remoteOwner: _block, ...content } = page;
  return jsonBytes(content);
}
