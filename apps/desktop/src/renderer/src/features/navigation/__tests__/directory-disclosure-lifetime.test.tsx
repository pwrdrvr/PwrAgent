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
