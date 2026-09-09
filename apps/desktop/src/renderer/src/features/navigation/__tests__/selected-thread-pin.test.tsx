import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { FixtureDirectoriesList as DirectoriesList } from "../../../test/navigation-presentation-fixture";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

afterEach(cleanup);

describe("Selected thread in a collapsed directory", () => {
  it("offers pin, switches to unpin after saving, and returns to a temporary row after unpinning", () => {
    const fixture = buildLargeDirectoryFixture({ pinnedThreadsPerDirectory: 1,
      unpinnedThreadsPerDirectory: 2, directoryThreadsCollapsed: true });
    const thread = fixture.threads[1]!;
    const selectedItemKey = buildThreadIdentityKey(thread.source, thread.id);
    const onSetThreadPin = vi.fn(async () => undefined);
    const onSelectThread = vi.fn();
    const props = { directories: fixture.directories, threads: fixture.threads,
      selectedItemKey, onSetThreadPin, onSelectThread,
      onOpenLaunchpad: async () => undefined, onOpenThreadContextMenu: () => undefined };
    const { rerender } = render(<DirectoriesList {...props} />);
    const retainedRow = () => screen.getByRole("button", { name: `${thread.title}, shown while open` }).closest('[role="listitem"]') as HTMLElement;
    expect(within(retainedRow()).queryByRole("button", { name: "Unpin thread" })).toBeNull();
    expect(within(retainedRow()).getByRole("button", { name: "Pin thread" }).querySelector("svg"))
      .toHaveAttribute("stroke-dasharray", "3 3");
    expect(retainedRow()).toHaveAttribute("data-thread-pin-state", "unpinned");
    fireEvent.click(within(retainedRow()).getByRole("button", { name: "Pin thread" }));
    expect(onSetThreadPin).toHaveBeenLastCalledWith(thread, true);
    expect(onSelectThread).not.toHaveBeenCalled();

    const pinned = { ...thread, pinnedRank: "4096" };
    rerender(<DirectoriesList {...props} threads={[fixture.threads[0]!, pinned, fixture.threads[2]!]} />);
    const pinnedRow = screen.getByRole("button", { name: `${thread.title}, pinned` }).closest('[role="listitem"]') as HTMLElement;
    expect(pinnedRow).toHaveAttribute("data-thread-pin-state", "pinned");
    fireEvent.click(within(pinnedRow).getByRole("button", { name: "Unpin thread" }));
    expect(onSetThreadPin).toHaveBeenLastCalledWith(pinned, false);
    rerender(<DirectoriesList {...props} />);
    expect(within(retainedRow()).getByRole("button", { name: "Pin thread" })).toBeInTheDocument();

    // Moving to another transcript removes the temporary row; returning restores it.
    rerender(<DirectoriesList {...props} selectedItemKey={buildThreadIdentityKey(fixture.threads[0]!.source, fixture.threads[0]!.id)} />);
    expect(screen.queryByRole("button", { name: `${thread.title}, shown while open` })).toBeNull();
    rerender(<DirectoriesList {...props} />);
    expect(retainedRow()).toBeInTheDocument();

    rerender(<DirectoriesList {...props} directories={fixture.directories.map((directory) => ({ ...directory, directoryThreadsCollapsed: false }))} />);
    const ordinaryRow = screen.getByRole("button", { name: thread.title }).closest('[role="listitem"]') as HTMLElement;
    expect(ordinaryRow.querySelector(".thread-row__heading-pin")).toBeNull();
  });
  it("retains the root and selected child without giving the child a pin action", () => {
    const fixture = buildLargeDirectoryFixture({ pinnedThreadsPerDirectory: 1,
      unpinnedThreadsPerDirectory: 2, directoryThreadsCollapsed: true });
    const parent = fixture.threads[1]!;
    const child = fixture.threads[2]!;
    child.parentThreadId = parent.id;
    render(<DirectoriesList directories={fixture.directories} threads={fixture.threads}
      selectedItemKey={buildThreadIdentityKey(child.source, child.id)}
      onSetThreadPin={async () => undefined} onSelectThread={() => undefined}
      onOpenLaunchpad={async () => undefined} onOpenThreadContextMenu={() => undefined} />);
    expect(screen.getByRole("button", { name: `${parent.title}, shown while open` })).toBeInTheDocument();
    const childRow = screen.getByRole("button", { name: child.title }).closest('[role="listitem"]') as HTMLElement;
    expect(within(childRow).queryByRole("button", { name: "Pin thread" })).toBeNull();
  });
});
