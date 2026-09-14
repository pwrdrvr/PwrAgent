import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { useNavigationDirectoryDisclosure } from "../../../lib/useNavigationDirectoryDisclosure";
import { FixtureDirectoriesList as DirectoriesList } from "../../../test/navigation-presentation-fixture";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

const fixture = buildLargeDirectoryFixture({ pinnedThreadsPerDirectory: 2, unpinnedThreadsPerDirectory: 12, directoryThreadsCollapsed: false });
function Window({ visible, selected = 0 }: { visible: boolean; selected?: number }) {
  const disclosure = useNavigationDirectoryDisclosure();
  const thread = fixture.threads[selected]!;
  return visible ? <DirectoriesList
    directoryDisclosure={disclosure}
    directories={fixture.directories}
    threads={fixture.threads}
    selectedItemKey={buildThreadIdentityKey(thread.source, thread.id)}
    onOpenLaunchpad={async () => {}}
    onOpenThreadContextMenu={() => {}}
    onSelectThread={() => {}}
  /> : null;
}

describe("window-owned directory disclosure", () => {
  it("preserves explicit collapse across lens unmounts and reveals a new selection", () => {
    const view = render(<Window visible />);
    expect(screen.queryByRole("list", { name: "Threads in Project 1" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Project 1" }));
    expect(screen.queryByRole("list", { name: "Threads in Project 1" })).toBeNull();
    view.rerender(<Window visible={false} />);
    view.rerender(<Window visible />);
    expect(screen.queryByRole("list", { name: "Threads in Project 1" })).toBeNull();
    view.rerender(<Window visible selected={1} />);
    expect(screen.queryByRole("list", { name: "Threads in Project 1" })).not.toBeNull();
  });
});

describe("directory disclosure writes", () => {
  it("does not rewrite disclosure state for a selection inside an open directory", () => {
    const observed: Record<string, boolean>[] = [];
    function ObservedWindow({ selected }: { selected: number }) {
      const disclosure = useNavigationDirectoryDisclosure();
      observed.push(disclosure.expandedByKey);
      const thread = fixture.threads[selected]!;
      return <DirectoriesList
        directoryDisclosure={disclosure}
        directories={fixture.directories}
        threads={fixture.threads}
        selectedItemKey={buildThreadIdentityKey(thread.source, thread.id)}
        onOpenLaunchpad={async () => {}}
        onOpenThreadContextMenu={() => {}}
        onSelectThread={() => {}}
      />;
    }

    const view = render(<ObservedWindow selected={0} />);
    const opened = observed.at(-1)!;
    expect(opened["directory:/fixture/project-1"]).toBe(true);

    // Selecting another thread in the same already-open directory must not
    // allocate a new disclosure map. That write changes nothing, re-renders
    // the navigation tree, and — because this effect re-runs whenever the
    // directory array arrives with a new identity — feeds itself.
    view.rerender(<ObservedWindow selected={1} />);
    expect(observed.at(-1)).toBe(opened);
    expect(new Set(observed).size).toBe(2);
  });

  it("dispatches nothing once the selected directory is open", () => {
    // An updater that returns `current` still had to be dispatched to say so,
    // and React counts the dispatch. While another update is pending on this
    // window's fiber — which is the normal state during a lens expansion — the
    // eager bail-out cannot apply, so the no-op schedules a real update from
    // inside the commit phase. Fifty consecutive commits carrying one is what
    // React stops with "Maximum update depth exceeded".
    const dispatched: unknown[] = [];
    function ObservedWindow({ selected }: { selected: number }) {
      const disclosure = useNavigationDirectoryDisclosure();
      const observedDisclosure = {
        ...disclosure,
        setExpandedByKey: ((value) => {
          dispatched.push(value);
          disclosure.setExpandedByKey(value);
        }) as typeof disclosure.setExpandedByKey,
      };
      const thread = fixture.threads[selected]!;
      // The presentation fixture rebuilds its directory array on every render,
      // which is the identity churn the hover-stable sidebar snapshot produces
      // while the pointer rests on a row and a page arrival produces during a
      // lens expansion. That is what makes the effect under test re-run here.
      return <DirectoriesList
        directoryDisclosure={observedDisclosure}
        directories={fixture.directories}
        threads={fixture.threads}
        selectedItemKey={buildThreadIdentityKey(thread.source, thread.id)}
        onOpenLaunchpad={async () => {}}
        onOpenThreadContextMenu={() => {}}
        onSelectThread={() => {}}
      />;
    }

    const view = render(<ObservedWindow selected={0} />);
    expect(dispatched).toHaveLength(1);

    dispatched.length = 0;
    view.rerender(<ObservedWindow selected={0} />);
    view.rerender(<ObservedWindow selected={1} />);
    view.rerender(<ObservedWindow selected={1} />);
    expect(dispatched).toEqual([]);
  });
});
