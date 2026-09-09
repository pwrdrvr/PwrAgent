import type { ReactElement } from "react";
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
    !resource.state.error
    && !initialLoad
    && !resource.state.rebaselineRequired
    && !resource.state.page?.nextCursor;
  if (nothingToShow) return null;
  return (
    <div role="listitem">
      {resource.state.error ? <p className="sidebar-error" role="alert">{resource.state.error}</p> : null}
      {initialLoad ? <p className="sidebar-empty">Loading sub-threads…</p> : null}
      {resource.state.rebaselineRequired ? (
        <SidebarShowMore
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
