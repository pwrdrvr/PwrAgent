import { act, render } from "@testing-library/react";
import { expect, it } from "vitest";
import fc from "fast-check";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { useNavigationDirectoryDisclosure, type NavigationDirectoryDisclosure } from "../../../lib/useNavigationDirectoryDisclosure";
import { FixtureDirectoriesList } from "../../../test/navigation-presentation-fixture";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

function checkFixpoint(selections: number[]) {
  const fixture = buildLargeDirectoryFixture({ directoryCount: 1, pinnedThreadsPerDirectory: 0, unpinnedThreadsPerDirectory: 3 });
  let disclosure!: NavigationDirectoryDisclosure;
  function Window({ selected }: { selected: number }) {
    disclosure = useNavigationDirectoryDisclosure();
    const thread = fixture.threads[selected]!;
    return <FixtureDirectoriesList directoryDisclosure={disclosure} directories={[...fixture.directories]}
      threads={fixture.threads} selectedItemKey={buildThreadIdentityKey(thread.source, thread.id)}
      onOpenLaunchpad={async () => {}} onOpenThreadContextMenu={() => {}} onSelectThread={() => {}} />;
  }
  const view = render(<Window selected={0} />);
  try {
    const opened = disclosure.expandedByKey;
    expect(opened[fixture.directories[0]!.key]).toBe(true);
    let selected = 0;
    for (selected of selections) {
      view.rerender(<Window selected={selected} />);
      // Revealing any row in an already-open directory is an identity
      // operation, including when snapshot arrays arrive freshly allocated.
      expect(disclosure.expandedByKey).toBe(opened);
      view.rerender(<Window selected={selected} />);
      expect(disclosure.expandedByKey).toBe(opened);
    }
    act(() => disclosure.setExpandedByKey({ ...opened, [fixture.directories[0]!.key]: false }));
    const closed = disclosure.expandedByKey;
    view.rerender(<Window selected={selected} />);
    expect(disclosure.expandedByKey).toBe(closed);
    // An explicit collapse stays closed until a genuinely new selection
    // needs reveal. That reveal must itself reach a fixpoint.
    const next = (selected + 1) % fixture.threads.length;
    view.rerender(<Window selected={next} />);
    const revealed = disclosure.expandedByKey;
    expect(revealed[fixture.directories[0]!.key]).toBe(true);
    view.rerender(<Window selected={next} />);
    expect(disclosure.expandedByKey).toBe(revealed);
  } finally { view.unmount(); }
}

it("reaches a directory-reveal fixpoint without allocating identical disclosure state", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 5 }), checkFixpoint), { numRuns: 25 });
});

it("reuses disclosure state when switching within an open project (shrunk #2108 regression)", () => {
  checkFixpoint([1, 0]);
});
