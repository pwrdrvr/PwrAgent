// Guards the ARIA shape of the Directories lens thread list.
//
// `ThreadRow` renders `role="listitem"`, so its container has to be a
// `role="list"` or axe reports `aria-required-parent` (critical) on every row.
// The catch is the other direction: a list owns ONLY listitem, so every other
// child of that container — the "Directory threads" disclosure, "Show more",
// and a row's sub-thread list — has to be wrapped in one, or the fix trades
// `aria-required-parent` for `aria-required-children`.
//
// `e2e/a11y.spec.ts` gates this with the real axe, but it needs Electron and a
// VM lab, so it is not what a contributor runs while editing this file. These
// assertions are the cheap half, and the second one is deliberately written as
// the general invariant ("every child is a listitem") rather than a count:
// that is the form that catches the NEXT child someone adds here, which is
// exactly how the sub-thread list slipped through the first time.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { DirectoriesList } from "../DirectoriesList";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

afterEach(() => {
  cleanup();
});

/**
 * One expanded directory carrying every child branch at once: two pinned rows
 * (so the pinned lane is reorderable and the disclosure mounts), an unpinned
 * lane past the ten-row cap (so "Show more" mounts), and a sub-thread of the
 * first pinned row (so `renderStaticSubthreads` mounts).
 */
function renderExpandedDirectory() {
  const fixture = buildLargeDirectoryFixture({
    pinnedThreadsPerDirectory: 2,
    unpinnedThreadsPerDirectory: 12,
    directoryThreadsCollapsed: false,
  });
  const parent = fixture.threads[0]!;
  // A child of the first pinned row. `resolveThreadParentKey` reads
  // `parentThreadId` and falls back to the child's own `source` for the
  // backend, so this is the whole link.
  fixture.threads[3]!.parentThreadId = parent.id;

  render(
    <DirectoriesList
      directories={fixture.directories}
      // Selecting a thread in the directory is what renders it expanded.
      selectedItemKey={buildThreadIdentityKey(parent.source, parent.id)}
      threads={fixture.threads}
      onOpenLaunchpad={async () => undefined}
      onOpenThreadContextMenu={() => undefined}
      onReorderThreadPins={async () => undefined}
      onSelectThread={() => undefined}
      onSetDirectoryThreadsCollapsed={async () => undefined}
      onSetSubthreadsCollapsed={async () => undefined}
      onUpdateSubthreadOrder={async () => undefined}
    />,
  );

  return screen.getByRole("list", { name: "Threads in Project 1" });
}

describe("Directories lens thread list ARIA", () => {
  it("gives the thread rows a list parent", () => {
    const threads = renderExpandedDirectory();

    // Every row's `role="listitem"` needs this ancestor; without it axe
    // reports `aria-required-parent` on all of them.
    expect(
      within(threads).getAllByRole("listitem").length,
    ).toBeGreaterThan(0);
    expect(threads).toHaveAttribute("aria-label", "Threads in Project 1");

    // The pinned lane, by the same selector `a11y.spec.ts` uses as its
    // precondition there. Validated here so a rename of the attribute fails
    // in a second rather than on a VM lab.
    expect(threads.querySelectorAll('[data-thread-pin-state="pinned"]'))
      .toHaveLength(2);
  });

  it("wraps every non-row child so the list owns only listitems", () => {
    const threads = renderExpandedDirectory();

    // The general invariant, not a count: a list owns only `listitem`, so any
    // direct child that is neither a listitem nor role-less (axe recurses
    // through those) fails `aria-required-children`.
    const offenders = [...threads.children]
      .filter((child) => {
        const role = child.getAttribute("role");
        return role !== null && role !== "listitem";
      })
      .map((child) => `${child.tagName.toLowerCase()}[role=${child.getAttribute("role")}].${child.className}`);
    expect(offenders).toEqual([]);

    // The list's composition, not just its validity. `a11y.spec.ts` asserts a
    // hard count of these direct children, and that number goes stale the
    // moment a child type is added or a role changes — which is exactly what
    // happened when the pin-drop boundary became a `listitem` and CI caught
    // the drift instead of this file. Splitting rows from non-rows makes the
    // staleness fail here, in a second.
    const children = [...threads.children];
    const rows = children.filter((child) =>
      child.classList.contains("thread-row-shell"),
    );
    const nonRows = children.filter(
      (child) => !child.classList.contains("thread-row-shell"),
    );
    // Two pinned + the ten-row cap (12 unpinned, one re-parented as a
    // sub-thread, so 11 against a cap of 10).
    expect(rows).toHaveLength(12);
    // The sub-thread list, the pin-drop boundary, the disclosure, "Show more".
    expect(nonRows).toHaveLength(4);

    // A bare <button> child has no explicit role but IS a button to axe, so
    // the role check above cannot see it. Assert both controls sit in a
    // wrapper. Names come from the fixture: the unpinned lane is 12 threads
    // minus the one re-parented as a sub-thread, so 11 against a cap of 10.
    for (const name of [
      "Hide directory threads for Project 1",
      "Show 1 more",
    ]) {
      const control = within(threads).getByRole("button", { name });
      expect(control.parentElement).toHaveAttribute("role", "listitem");
      expect(control.parentElement?.parentElement).toBe(threads);
    }
  });

  it("wraps a row's sub-thread list in a listitem", () => {
    const threads = renderExpandedDirectory();

    // The sub-thread list is a SIBLING of its parent row — it is returned into
    // a Fragment beside <ThreadRow/>, which renders no DOM node — so it lands
    // directly inside the thread list. A nested `role="list"` there is not a
    // permitted child.
    const subthreads = within(threads).getByRole("list", {
      name: /^Sub-threads of /,
    });
    expect(subthreads.parentElement).toHaveAttribute("role", "listitem");
    expect(subthreads.parentElement?.parentElement).toBe(threads);
  });
});
