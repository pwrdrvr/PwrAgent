import "@testing-library/jest-dom/vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { ThreadMarkdown } from "../ThreadMarkdown";
import { remarkTableProfile } from "../remark-table-profile";

vi.mock("../remark-table-profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remark-table-profile")>();
  return { ...actual, remarkTableProfile: vi.fn(actual.remarkTableProfile) };
});

afterEach(() => vi.clearAllMocks());

it("updates thread links when membership changes without reparsing unchanged Markdown", () => {
  const id = "019f5d79-a595-73f2-84d9-a0976762c303";
  const thread: NavigationThreadSummary = {
    id,
    title: "Newly available thread",
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    inbox: { inInbox: false },
  };
  const onShowThread = vi.fn();
  const onOpenRemoteViewer = vi.fn();
  const text = `See [related work](pwragent://thread/${id}?backend=codex) and \`${id}\`.`;
  const view = (threads: NavigationThreadSummary[], markdown = text) => (
    <ThreadLinkProvider threads={threads} onShowThread={onShowThread} onOpenRemoteViewer={onOpenRemoteViewer}>
      <ThreadMarkdown text={markdown} />
    </ThreadLinkProvider>
  );
  const { rerender } = render(view([]));
  const parses = vi.mocked(remarkTableProfile).mock.calls.length;
  expect(parses).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Open thread Newly available thread" })).not.toBeInTheDocument();

  rerender(view([thread]));
  const links = screen.getAllByRole("button", { name: "Open thread Newly available thread" });
  expect(links).toHaveLength(2);
  fireEvent.click(links[0]);
  expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: id }));
  expect(remarkTableProfile).toHaveBeenCalledTimes(parses);

  // A loaded-page omission is not deletion. Both mounted links retain their
  // exact identity and remain actionable without reparsing the Markdown.
  rerender(view([]));
  const retainedLinks = screen.getAllByRole("button", { name: "Open thread Newly available thread" });
  expect(retainedLinks).toHaveLength(2);
  fireEvent.click(retainedLinks[1]);
  expect(onShowThread).toHaveBeenCalledTimes(2);
  expect(onShowThread).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: id }));
  expect(remarkTableProfile).toHaveBeenCalledTimes(parses);

  rerender(view([], `${text}\n\nNew content.`));
  expect(screen.getByText("New content.")).toBeInTheDocument();
  expect(vi.mocked(remarkTableProfile).mock.calls.length).toBeGreaterThan(parses);
});
