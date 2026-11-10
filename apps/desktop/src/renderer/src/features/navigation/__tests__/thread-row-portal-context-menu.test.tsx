import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";

afterEach(cleanup);

const thread: NavigationThreadSummary = {
  id: "thread-portal-menu",
  source: "codex",
  title: "Portal menus",
  titleSource: "explicit",
  updatedAt: 1,
  inbox: { inInbox: false },
  linkedDirectories: [],
};

describe("ThreadRow right-click", () => {
  it("opens the thread menu from the row but not from a portal the row mounts", () => {
    const onOpenContextMenu = vi.fn();
    render(
      <ThreadRow
        thread={thread}
        onSelectThread={vi.fn()}
        onOpenContextMenu={onOpenContextMenu}
        onSetReaction={vi.fn(async () => undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add reaction to thread" }));
    // The picker is a portal on <body>, outside the row's DOM.
    fireEvent.contextMenu(screen.getByRole("menu", { name: "Add reaction" }));
    expect(onOpenContextMenu).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByText("Portal menus"));
    expect(onOpenContextMenu).toHaveBeenCalledOnce();
  });
});
