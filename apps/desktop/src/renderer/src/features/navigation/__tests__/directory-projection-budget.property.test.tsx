import { cleanup, render, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationDirectoryRow, NavigationQueryEntry, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { readNavigationPresentationOrder } from "../navigation-presentation-order";
import * as children from "../paged-directory-presentation";
import * as trays from "../subthread-trays";
import { DirectoriesList } from "../DirectoriesList";
import { useDirectoryTrays } from "../useDirectoryTrays";

vi.mock("../ThreadRow", () => ({ ThreadRow: (props: { thread: NavigationRow }) => <span>{props.thread.title}</span> }));
const noop = () => {};
const asyncNoop = async () => {};

function fixture(count: number) {
  const directory: NavigationDirectoryRow = { key: "directory:/fixture", kind: "directory", label: "Fixture",
    path: "/fixture", counts: { total: count, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0,
    unpinnedRootCount: 1, launchpadPresent: false };
  const rows: NavigationRow[] = Array.from({ length: count }, (_, index) => ({
    id: `fixture-${index}`, source: "codex", title: `Title ${index}`, titleSource: "explicit",
    ref: { backend: "codex", threadId: `fixture-${index}` }, rowRevision: "r", linkedDirectories: [],
    inbox: { inInbox: false }, ordinaryChildCount: index === 0 ? count - 1 : 0,
    nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown", subthreadsCollapsed: index === 0,
    ...(index > 0 ? { parentThreadId: "fixture-0" } : {}),
  }));
  const resources = new Map<string, NavigationWindowResource>();
  const add = (id: string, query: NavigationQueryRequest["query"], entries: NavigationQueryEntry[]) => {
    resources.set(id, { id, loading: false, state: { ...createNavigationPageState({ protocol: 2, consumer: "main-sidebar", query }),
      page: { protocol: 2, queryKey: id, generation: "g", ownerEpoch: "owner", countsRevision: "r", coverage: { state: "complete" },
        counts: { total: count, active: 0, unread: 0, review: 0 }, entries, complete: true } } });
  };
  add(`directory:${directory.key}`, { kind: "directory", directoryKey: directory.key }, [{ row: rows[0]!, placement: { kind: "root" }, orderKey: "0" }]);
  add("children", { kind: "children", directoryKey: directory.key, parent: rows[0]!.ref }, rows.slice(1).map((row, index) => ({
    row, placement: { kind: "child", parent: rows[0]!.ref }, orderKey: String(index),
  })));
  return { rows, directory, resources };
}

function mounted(count: number) {
  const data = fixture(count);
  const presentationOrder = readNavigationPresentationOrder(data.resources);
  const pagedNavigation = { resources: data.resources, presentationReady: true, directories: [data.directory], selectedDirectoryKeys: undefined, connected: true,
    refresh: asyncNoop, invalidate: noop, loadMore: asyncNoop, rebaseline: asyncNoop, restart: asyncNoop, setVisibleAnchor: noop };
  const directoryDisclosure = { expandedByKey: { [data.directory.key]: true }, unpinnedExpandedByKey: {},
    setExpandedByKey: noop, setUnpinnedExpandedByKey: noop, previousSelectedItemKeyRef: { current: undefined }, handledRevealRequestRef: { current: 0 } };
  const props = { directories: [data.directory], threads: data.rows, presentationOrder, pagedNavigation, directoryDisclosure,
    onOpenLaunchpad: asyncNoop, onOpenThreadContextMenu: noop, onSelectThread: noop, onSetSubthreadsCollapsed: asyncNoop };
  const view = render(<DirectoriesList {...props} />);
  return { ...data, view, update: (rows: NavigationRow[]) => view.rerender(<DirectoriesList {...props} threads={rows} />) };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("retains tray plans only for directories rendered by the current commit", () => {
  const rows = fixture(8).rows;
  const params = { children: new Map([["codex:fixture-0", rows.slice(1)]]), owners: rows.slice(0, 1),
    ownerChildOrder: new Map<string, string[]>(), options: {}, threadsByKey: new Map(rows.map((row) => [`codex:${row.id}`, row])) };
  const view = renderHook(({ ids }) => {
    const read = useDirectoryTrays();
    return ids.map((id) => read(id, params));
  }, { initialProps: { ids: ["a"] } });
  const builds = vi.spyOn(trays, "createSubthreadTrays");
  view.rerender({ ids: ["a"] });
  expect(builds).not.toHaveBeenCalled();
  view.rerender({ ids: ["b"] });
  expect(builds).toHaveBeenCalledTimes(1);
  view.rerender({ ids: ["a"] });
  expect(builds).toHaveBeenCalledTimes(2);
});

for (const count of [32, 64]) {
  it(`does not rebuild ${count}-row child and tray plans for one or twenty shell actions`, () => {
    const f = mounted(count);
    const childBuild = vi.spyOn(children, "buildPagedDirectoryChildren");
    const childKeyBuild = vi.spyOn(children, "buildPagedDirectoryChildKeys");
    const trayBuild = vi.spyOn(trays, "createSubthreadTrays");
    for (let action = 0; action < 20; action++) {
      f.update(f.rows);
      expect(childBuild).not.toHaveBeenCalled();
      expect(childKeyBuild).not.toHaveBeenCalled();
      expect(trayBuild).not.toHaveBeenCalled();
    }
  });

  it(`keeps ${count}-row membership plans while publishing fresh root metadata`, () => {
    const f = mounted(count);
    const childBuild = vi.spyOn(children, "buildPagedDirectoryChildren");
    const childKeyBuild = vi.spyOn(children, "buildPagedDirectoryChildKeys");
    const trayBuild = vi.spyOn(trays, "createSubthreadTrays");
    for (let action = 0; action < 20; action++) {
      const rows = f.rows.map((row, index) => index === 0 ? { ...row, title: `Updated ${action}` } : row);
      f.update(rows);
      expect(f.view.getByText(`Updated ${action}`)).toBeTruthy();
      expect(childBuild).not.toHaveBeenCalled();
      expect(childKeyBuild).not.toHaveBeenCalled();
      expect(trayBuild).not.toHaveBeenCalled();
    }
  });
}

it("keeps membership plans under generated fresh metadata without freezing row titles", () => {
  fc.assert(fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 20 }), (actions) => {
    const f = mounted(16);
    const childBuild = vi.spyOn(children, "buildPagedDirectoryChildren");
    const childKeyBuild = vi.spyOn(children, "buildPagedDirectoryChildKeys");
    const trayBuild = vi.spyOn(trays, "createSubthreadTrays");
    try {
      for (const action of actions) {
        f.update(f.rows.map((row) => ({ ...row, title: `Updated ${row.id} / ${action}` })));
        expect(f.view.getByText(`Updated fixture-0 / ${action}`)).toBeTruthy();
        expect(childBuild).not.toHaveBeenCalled();
        expect(childKeyBuild).not.toHaveBeenCalled();
        expect(trayBuild).not.toHaveBeenCalled();
      }
    } finally { f.view.unmount(); vi.restoreAllMocks(); }
  }), { numRuns: 25 });
});
