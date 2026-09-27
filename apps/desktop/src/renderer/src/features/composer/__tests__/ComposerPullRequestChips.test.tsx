import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { PullRequestLinkProvider } from "../../../lib/pull-request-links";
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

function composer(prs = [fork, upstream]) {
  const active: NavigationThreadSummary = {
    source: "codex", id: "disktree-thread", title: "DiskTree", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: true }, prs,
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
