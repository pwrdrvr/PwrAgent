import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { PullRequestLinkProvider } from "../../../lib/pull-request-links";
import { Composer } from "../Composer";
import { ComposerTiptapInput } from "../ComposerTiptapInput";
import { createComposerPullRequestToken, serializeDraftWithSkillTokens } from "../composer-mention-tokens";

const fork: PrSummary = {
  provider: "github.com", org: "contributor", repo: "diskhound", number: 4,
  url: "https://github.com/contributor/diskhound/pull/4", title: "Surface APFS snapshots",
  state: "passing", checkState: "passing", lifecycleState: "open", additions: 12,
};
const upstream: PrSummary = {
  ...fork, org: "upstream", url: "https://github.com/upstream/diskhound/pull/4",
  title: "Upstream scan changes", state: "failing", checkState: "failing", additions: 70,
};

function composer(prs = [fork, upstream], peer = false) {
  const active: NavigationThreadSummary = {
    source: "codex", id: "disktree-thread", title: "DiskTree", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: true }, prs,
    ...(peer ? { federation: { ref: { target: { scope: "remote" as const, instanceId: "peer" }, backend: "codex" as const, threadId: "peer-thread" }, instanceLabel: "Peer" } } : {}),
  };
  return (
    <PullRequestLinkProvider activeThread={active} threads={[active]}>
      <ComposerTiptapInput id="reply" label="Reply" value="Compare " placeholder="Reply"
        onChange={() => undefined} skillTokens={[fork, upstream].map((pr) => createComposerPullRequestToken(pr, 8))} />
    </PullRequestLinkProvider>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows repository provenance for overlapping picked PR numbers and preserves their URLs", () => {
  const view = render(composer());
  const chips = view.container.querySelectorAll(".composer-pr-chip");
  expect(chips[0]).toHaveTextContent("contributor/diskhound#4");
  expect(chips[1]).toHaveTextContent("upstream/diskhound#4");
  expect(serializeDraftWithSkillTokens("See ", [createComposerPullRequestToken(fork, 4)]))
    .toBe(`See [contributor/diskhound#4](${fork.url})`);
});

it("shows the matching live PR card on hover and keyboard focus", async () => {
  const view = render(composer());
  const chips = view.container.querySelectorAll(".composer-pr-chip");
  fireEvent.pointerOver(chips[0]!);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByRole("tooltip")).toHaveTextContent("Surface APFS snapshots");
  expect(screen.getByRole("tooltip")).not.toHaveTextContent("Upstream scan changes");
  expect(chips[0]).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
  view.rerender(composer([{ ...fork, title: "Updated fork title", additions: 30 }, upstream]));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Updated fork title");
  fireEvent.pointerOut(chips[0]!);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.focusIn(chips[1]!);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Upstream scan changes");
  fireEvent.keyDown(chips[1]!, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(chips[1]).not.toHaveAttribute("aria-describedby");
});

it("restores provenance and fetches missing status on demand without changing the draft", async () => {
  const url = `${fork.url}/files#diff-123`;
  const set = vi.fn().mockResolvedValue({ statuses: [{ pr: fork, fetchedAt: 100 }] });
  vi.stubGlobal("pwragent", { setTranscriptPullRequests: set, onTranscriptPullRequestStatuses: () => () => {} });
  const onChange = vi.fn();
  const view = render(<ComposerTiptapInput id="restored" label="Reply" value="" skillTokens={[]}
    placeholder="Reply" onChange={onChange} editorDocument={{ type: "doc", content: [{ type: "paragraph", content: [{
      type: "mention", attrs: { kind: "pull-request", name: "#4", path: url, id: "restored-pr" },
    }] }] }} />);
  const chip = view.container.querySelector(".composer-pr-chip")!;
  expect(chip).toHaveTextContent("contributor/diskhound#4");
  expect(chip).toHaveAttribute("data-skill-path", url);
  expect(set).not.toHaveBeenCalled();
  // Hydration reports the restored document before the user interacts.
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  onChange.mockClear();
  fireEvent.pointerOver(chip);
  fireEvent.pointerOut(chip);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(set).not.toHaveBeenCalled();
  fireEvent.pointerOver(chip);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(set).toHaveBeenCalledWith({ updates: [{ url, visible: true }], removedUrls: [] });
  expect(screen.getByRole("tooltip")).toHaveTextContent("Surface APFS snapshots");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerOut(chip);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(set).toHaveBeenLastCalledWith({ updates: [], removedUrls: [url] });
});

it("releases on-demand interest when the composer unmounts", async () => {
  const set = vi.fn().mockResolvedValue({ statuses: [] });
  const unsubscribe = vi.fn();
  vi.stubGlobal("pwragent", { setTranscriptPullRequests: set, onTranscriptPullRequestStatuses: () => unsubscribe });
  const view = render(composer());
  const chip = view.container.querySelector(".composer-pr-chip")!;
  fireEvent.focusIn(chip);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(set).toHaveBeenCalledWith({ updates: [{ url: fork.url, visible: true }], removedUrls: [] });
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(set).toHaveBeenLastCalledWith({ updates: [], removedUrls: [fork.url] });
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it.each(["rich text", "plain text"])("preserves the exact PR identity when copied as %s into another composer", (format) => {
  const url = `${fork.url}/files#diff-123`;
  const source = render(<ComposerTiptapInput id="source" label="Source reply" value="See " placeholder="Reply"
    markdownConversion onChange={() => undefined} skillTokens={[createComposerPullRequestToken({ ...fork, url }, 4)]} />);
  const editor = (screen.getByRole("textbox", { name: "Source reply" }) as HTMLElement & { editor: Editor }).editor;
  act(() => { editor.commands.selectAll(); });
  const clipboard = new Map<string, string>();
  fireEvent.copy(editor.view.dom, { clipboardData: { clearData: () => clipboard.clear(), setData: (type: string, value: string) => clipboard.set(type, value) } });
  expect(clipboard.get("text/plain")).toBe(`See [contributor/diskhound#4](${url})`);
  expect(clipboard.get("text/html")).toContain(url);
  source.unmount();

  const otherPr = { ...fork, repo: "disktree", url: "https://github.com/contributor/disktree/pull/4" };
  const destinationThread: NavigationThreadSummary = {
    source: "codex", id: "destination", title: "DiskTree", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: true }, prs: [otherPr],
  };
  const destination = render(<PullRequestLinkProvider activeThread={destinationThread} threads={[destinationThread]}>
    <Composer disabled={false} skills={[]} thread={destinationThread} threads={[destinationThread]}
      desktopApi={{ onAgentEvent: () => () => undefined, startTurn: vi.fn() }} />
  </PullRequestLinkProvider>);
  fireEvent.paste(screen.getByRole("textbox", { name: "Reply" }), {
    clipboardData: { getData: (type: string) => format === "plain text" && type === "text/html" ? "" : clipboard.get(type) ?? "", files: [], items: [], types: format === "plain text" ? ["text/plain"] : ["text/plain", "text/html"] },
  });
  const chip = destination.container.querySelector(".composer-pr-chip");
  expect(chip).toHaveTextContent("contributor/diskhound#4");
  expect(chip).toHaveAttribute("data-skill-path", url);
  expect(chip).not.toHaveTextContent("contributor/disktree#4");
});

it("prefers a pinned peer's newer status over an earlier local composer hover fetch", async () => {
  const set = vi.fn().mockResolvedValue({ statuses: [{ pr: fork, fetchedAt: 100 }] });
  vi.stubGlobal("pwragent", { setTranscriptPullRequests: set, onTranscriptPullRequestStatuses: () => () => {} });
  const view = render(composer([], true));
  fireEvent.focusIn(view.container.querySelector(".composer-pr-chip")!);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(screen.getByRole("tooltip")).toHaveTextContent("checks passing");
  view.rerender(composer([{ ...fork, title: "Peer merged this PR", state: "merged", lifecycleState: "merged" }], true));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Peer merged this PR");
  expect(screen.getByRole("tooltip")).toHaveTextContent("merged");
  expect(screen.getByRole("tooltip")).not.toHaveTextContent("checks passing");
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(set).toHaveBeenLastCalledWith({ updates: [], removedUrls: [fork.url] });
});
