import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { DirectoriesList } from "../DirectoriesList";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

const threadRowRender = vi.hoisted(() => vi.fn());

vi.mock("../ThreadRow", () => ({
  ThreadRow: (props: { thread: NavigationThreadSummary }) => {
    threadRowRender(props.thread.id);
    return <div data-testid="fixture-thread-row">{props.thread.title}</div>;
  },
}));

afterEach(() => {
  threadRowRender.mockClear();
  cleanup();
});

function renderDirectories(
  fixture: ReturnType<typeof buildLargeDirectoryFixture>,
  selectedItemKey?: string,
) {
  return render(
    <DirectoriesList
      directories={fixture.directories}
      selectedItemKey={selectedItemKey}
      threads={fixture.threads}
      onOpenLaunchpad={async () => undefined}
      onOpenThreadContextMenu={() => undefined}
      onSelectThread={() => undefined}
    />,
  );
}

describe("large collapsed directory rendering", () => {
  it("mounts no thread rows for twelve collapsed three-digit projects", () => {
    const fixture = buildLargeDirectoryFixture({
      directoryCount: 12,
      pinnedThreadsPerDirectory: 1,
      unpinnedThreadsPerDirectory: 107,
    });

    renderDirectories(fixture);

    expect(
      screen.getAllByRole("button", { name: /^Project \d+$/ }),
    ).toHaveLength(12);
    expect(threadRowRender).not.toHaveBeenCalled();
    expect(screen.queryByTestId("fixture-thread-row")).not.toBeInTheDocument();
  });

  it("mounts only the pinned row above a minimized population of 107", () => {
    const fixture = buildLargeDirectoryFixture({
      pinnedThreadsPerDirectory: 1,
      unpinnedThreadsPerDirectory: 107,
      directoryThreadsCollapsed: true,
    });
    const pinned = fixture.threads[0]!;

    renderDirectories(
      fixture,
      buildThreadIdentityKey(pinned.source, pinned.id),
    );

    expect(screen.getByText(pinned.title)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Show directory threads for Project 1",
      }),
    ).toHaveTextContent("107");
    expect(screen.getAllByTestId("fixture-thread-row")).toHaveLength(1);
    expect(
      threadRowRender.mock.calls.every(([threadId]) => threadId === pinned.id),
    ).toBe(true);
  });
});
