import type { ReactElement } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { isNavigationPeerUnavailable, navigationIdentityKey } from "../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../lib/navigation-window-queries";
import type { useBoundedNavigationWindow } from "../../lib/useBoundedNavigationWindow";
import { SidebarShowMore } from "./SidebarShowMore";

/**
 * The paging tail of one sub-thread tray, shared by DirectoriesList and
 * RecentsList.
 *
 * The wrapper is not decoration. `.subthread-list` carries `role="list"`,
 * which owns `listitem` children and nothing else, so the bare `<button>` and
 * `<p>` this used to render were an `aria-required-children` violation on
 * every tray with a second page. The sibling pinned-thread block a few
 * hundred lines down already wraps its identical controls in a `listitem`;
 * this one never did. The `nothingToShow` guard keeps the list free of an
 * empty item when the tray is fully loaded — the common case.
 */
export function SubthreadPagination(props: {
  resource: NavigationWindowResource;
  pagedNavigation?: ReturnType<typeof useBoundedNavigationWindow>;
}): ReactElement | null {
  const { resource } = props;
  const initialLoad = resource.loading && !resource.state.page;
  const nothingToShow =
    !initialLoad
    && !resource.state.rebaselineRequired
    && !resource.state.page?.nextCursor;
  if (nothingToShow) return null;
  return (
    <div role="listitem">
      {initialLoad ? <p className="sidebar-empty">Loading sub-threads…</p> : null}
      {resource.state.rebaselineRequired ? (
        <SidebarShowMore
          kind="reload"
          label="Reload sub-threads"
          onClick={() => void props.pagedNavigation?.restart(resource.id)}
        />
      ) : resource.state.page?.nextCursor ? (
        <SidebarShowMore
          busy={resource.loading}
          label={resource.id.endsWith(":viewer") ? "Load more sub-threads on this machine" : "Load more sub-threads"}
          onClick={() => void props.pagedNavigation?.loadMore(resource.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * A parent's loaded child pages: its owner's, plus this machine's own when
 * the parent belongs to a peer. Every row with sub-threads pages its own
 * children, a sub-thread as much as a top-level row.
 */
export function subthreadPageResources(
  parent: NavigationThreadSummary,
  resources: ReadonlyMap<string, NavigationWindowResource> | undefined,
): NavigationWindowResource[] {
  const owner = parent.federation?.ref.target;
  const id = `children:${navigationIdentityKey({ backend: parent.source, threadId: parent.id,
    ownerInstanceId: owner?.scope === "remote" ? owner.instanceId : undefined })}`;
  return [id, `${id}:viewer`].flatMap((resourceId) => {
    const resource = resources?.get(resourceId);
    return resource ? [resource] : [];
  });
}

/** `SubthreadPagination` for each of a parent's reachable child pages. */
export function renderSubthreadPages(
  parent: NavigationThreadSummary,
  pagedNavigation: ReturnType<typeof useBoundedNavigationWindow> | undefined,
): ReactElement[] {
  return subthreadPageResources(parent, pagedNavigation?.resources)
    .filter((resource) => !isNavigationPeerUnavailable(resource.state.error))
    .map((resource) => (
      <SubthreadPagination key={resource.id} resource={resource} pagedNavigation={pagedNavigation} />
    ));
}
