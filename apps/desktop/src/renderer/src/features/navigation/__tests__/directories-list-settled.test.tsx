import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { FixtureDirectoriesList as DirectoriesList } from "../../../test/navigation-presentation-fixture";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

/**
 * A project draws pins, then Unpinned, then Settled. Settled shows only while
 * the project has settled roots, starts folded, and folds on its own key. A
 * row is drawn once, in its own section.
 */

afterEach(cleanup);

function renderProject(options: { settled: number; settledCollapsed?: boolean; directoryThreadsCollapsed?: boolean }) {
  const fixture = buildLargeDirectoryFixture({
    pinnedThreadsPerDirectory: 1,
    unpinnedThreadsPerDirectory: 4,
    directoryThreadsCollapsed: options.directoryThreadsCollapsed ?? false,
  });
  // The last unpinned roots are the settled ones.
  fixture.threads.slice(fixture.threads.length - options.settled).forEach((thread, index) => {
    thread.settledAt = 1_000 + index;
  });
  const directories = fixture.directories.map((directory) => ({
    ...directory,
    ...(options.settledCollapsed !== undefined ? { settledCollapsed: options.settledCollapsed } : {}),
  }));
  const onSetDirectorySettledCollapsed = vi.fn(async () => undefined);
  const onSetDirectoryThreadsCollapsed = vi.fn(async () => undefined);
  const pinned = fixture.threads[0]!;
  render(
    <DirectoriesList
      directories={directories}
      selectedItemKey={buildThreadIdentityKey(pinned.source, pinned.id)}
      threads={fixture.threads}
      onOpenLaunchpad={async () => undefined}
      onOpenThreadContextMenu={() => undefined}
      onReorderThreadPins={async () => undefined}
      onSelectThread={() => undefined}
      onSetDirectoryThreadsCollapsed={onSetDirectoryThreadsCollapsed}
      onSetDirectorySettledCollapsed={onSetDirectorySettledCollapsed}
      onSetSubthreadsCollapsed={async () => undefined}
      onUpdateSubthreadOrder={async () => undefined}
    />,
  );
  const list = screen.getByRole("list", { name: "Threads in Project 1" });
  const order = () => [...list.querySelectorAll<HTMLElement>("[data-thread-pin-state], .directory-row__thread-divider")]
    .map((node) => node.dataset.section ? `[${node.dataset.section}]` : node.textContent?.match(/thread \d+/)?.[0] ?? "?");
  return { list, order, onSetDirectorySettledCollapsed, onSetDirectoryThreadsCollapsed };
}

it("draws no Settled section in a project with nothing settled", () => {
  const { list, order } = renderProject({ settled: 0 });
  expect(list.querySelector('[data-section="settled"]')).toBeNull();
  expect(order()).toEqual(["thread 1", "[unpinned]", "thread 2", "thread 3", "thread 4", "thread 5"]);
});

it("starts folded, below Unpinned, with its rows out of Unpinned", () => {
  const { list, order } = renderProject({ settled: 2 });
  const divider = within(list).getByRole("button", { name: "Show settled threads for Project 1" });
  expect(divider).toHaveAttribute("aria-expanded", "false");
  // Counts are drawn by CSS from data-count; Unpinned no longer counts the settled.
  const count = (section: string) => list.querySelector(`[data-section="${section}"] .directory-row__thread-divider-count`)
    ?.getAttribute("data-count");
  expect(count("settled")).toBe("2");
  expect(count("unpinned")).toBe("2");
  expect(order()).toEqual(["thread 1", "[unpinned]", "thread 2", "thread 3", "[settled]"]);
  // Every child of the list is a listitem, the Settled section's included.
  for (const child of list.children) expect(child).toHaveAttribute("role", "listitem");
});

it("lists settled roots once the section is opened, and folds it on its own key", () => {
  const { list, order, onSetDirectorySettledCollapsed, onSetDirectoryThreadsCollapsed } = renderProject({ settled: 2, settledCollapsed: false });
  expect(order()).toEqual(["thread 1", "[unpinned]", "thread 2", "thread 3", "[settled]", "thread 4", "thread 5"]);
  fireEvent.click(within(list).getByRole("button", { name: "Hide settled threads for Project 1" }));
  expect(onSetDirectorySettledCollapsed).toHaveBeenCalledWith(expect.objectContaining({ key: expect.any(String) }), true);
  expect(onSetDirectoryThreadsCollapsed).not.toHaveBeenCalled();
});

it("keeps Settled reachable while Unpinned is folded", () => {
  const { order } = renderProject({ settled: 2, settledCollapsed: false, directoryThreadsCollapsed: true });
  expect(order()).toEqual(["thread 1", "[unpinned]", "[settled]", "thread 4", "thread 5"]);
});
