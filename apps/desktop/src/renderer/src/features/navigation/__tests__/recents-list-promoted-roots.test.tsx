import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import { createNavigationPageState, navigationIdentityKey } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { RecentsList } from "../RecentsList";

afterEach(cleanup);

it.each([false, true])("gives promoted Attention roots their own rows, descendants, and selection positions (promoted first: %s)", (promotedFirst) => {
  const thread = (id: string, patch: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary => ({
    id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [],
    inbox: { inInbox: false }, subthreadsCollapsed: false, ...patch,
  });
  const grandparent = thread("Active grandparent", { threadStatus: "active" });
  const parent = thread("Idle parent", { parentThreadId: grandparent.id });
  const grandchild = thread("Unread grandchild", { parentThreadId: parent.id, inbox: { inInbox: true } });
  const leaf = thread("Grandchild's child", { parentThreadId: grandchild.id });
  const threads = promotedFirst ? [grandchild, grandparent, parent, leaf] : [grandparent, parent, grandchild, leaf];
  const resources = new Map<string, NavigationWindowResource>();
  const add = (id: string, query: NavigationQueryRequest["query"]) => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query, pageSize: 10 };
    const page = navigationQueryFixture(request, { threads });
    resources.set(id, { id, loading: false, state: { ...createNavigationPageState(request), page } });
    return page;
  };
  const lens = add("lens", { kind: "lens", lens: "attention" });
  for (const row of [grandparent, parent, grandchild]) {
    const ref = { backend: row.source, threadId: row.id };
    add(`children:${navigationIdentityKey(ref)}`, { kind: "children", parent: ref });
  }
  const navigation = {
    resources, presentationReady: true, directories: [], selectedDirectoryKeys: undefined, connected: true,
    invalidate: vi.fn(), refresh: vi.fn(async () => undefined), loadMore: vi.fn(async () => undefined),
    rebaseline: vi.fn(async () => undefined), restart: vi.fn(async () => undefined), setVisibleAnchor: vi.fn(),
  };
  const onSelectThread = vi.fn();
  const props = {
    pagedNavigation: navigation,
    threads: lens.entries.map(({ row }) => row),
    loadedThreads: [...resources.values()].flatMap((resource) => resource.state.page!.entries.map(({ row }) => row)),
    onSelectThread, onOpenThreadContextMenu: vi.fn(),
  };
  const view = render(<RecentsList {...props} />);

  expect.soft(screen.getAllByRole("button", { name: grandchild.title })).toHaveLength(1);
  expect.soft(screen.getAllByRole("button", { name: leaf.title })).toHaveLength(1);
  const grandparentTray = screen.getByRole("list", { name: `Sub-threads of ${grandparent.title}` });
  expect.soft(within(grandparentTray).queryByRole("button", { name: grandchild.title })).not.toBeInTheDocument();
  const promotedTray = screen.getByRole("list", { name: `Sub-threads of ${grandchild.title}` });
  expect.soft(within(promotedTray).queryByRole("button", { name: leaf.title })).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole("button", { name: grandchild.title }).at(-1)!, { shiftKey: true });
  const expected = promotedFirst ? [grandchild, leaf, grandparent, parent] : [grandparent, parent, grandchild, leaf];
  expect(onSelectThread).toHaveBeenLastCalledWith(expect.objectContaining({ id: grandchild.id }),
    expect.objectContaining({ shiftKey: true }), expected.map((row) => `codex:${row.id}`));

  // A promoted root owns its disclosure too. Its descendants must not leak
  // back into the ancestor tray when that root is collapsed.
  const collapse = (row: NavigationThreadSummary) => row.id === grandchild.id ? { ...row, subthreadsCollapsed: true } : row;
  view.rerender(<RecentsList {...props} threads={props.threads.map(collapse)} loadedThreads={props.loadedThreads.map(collapse)} />);
  expect(screen.queryByRole("button", { name: leaf.title })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: grandchild.title })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: grandchild.title }), { shiftKey: true });
  expect(onSelectThread).toHaveBeenLastCalledWith(expect.objectContaining({ id: grandchild.id }),
    expect.objectContaining({ shiftKey: true }), expected.filter((row) => row !== leaf).map((row) => `codex:${row.id}`));
});
