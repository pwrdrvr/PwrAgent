import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkdownFileViewerContext, MarkdownFileViewerSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { MarkdownFilesWindow } from "../MarkdownFilesWindow";
import { ThreadMarkdown } from "../ThreadMarkdown";

const path = "/repo/report.md";
const content = "# Report\n\nKeep this selected `inline text` and [nested report](/repo/nested.md).";

function context(remote = false): MarkdownFileViewerContext {
  return {
    key: "codex:reader",
    title: "Files - Reader",
    threadTitle: "Reader",
    projectPath: "/repo",
    thread: { backend: "codex", threadId: "reader" },
    ...(remote ? { federationTarget: { scope: "remote", instanceId: "owner" } as const } : {}),
  };
}

function selectDocument(dialog: HTMLElement, scrollSelector: string) {
  const paragraph = within(dialog).getByText("Keep this selected", { exact: false });
  const text = paragraph.firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(paragraph, paragraph.childNodes.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const scroll = dialog.querySelector<HTMLElement>(scrollSelector)!;
  scroll.scrollTop = 640;
  return { paragraph, text, selection, scroll, selectedText: selection.toString() };
}

function expectDocumentPreserved(saved: ReturnType<typeof selectDocument>) {
  expect(saved.paragraph).toBeInTheDocument();
  expect(saved.text.isConnected).toBe(true);
  expect(saved.selection.anchorNode).toBe(saved.text);
  expect(saved.selection.focusNode).toBe(saved.paragraph);
  expect(saved.selection.toString()).toBe(saved.selectedText);
  expect(saved.scroll.scrollTop).toBe(640);
  expect(screen.queryByText("Loading file…")).not.toBeInTheDocument();
}

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  delete (window as Window & { pwragent?: DesktopApi }).pwragent;
  window.location.hash = "";
});

describe("document viewer stability", () => {
  it.each(["thread", "backend", "owner"] as const)("reloads for a changed %s identity and ignores the previous pending read", async (changed) => {
    let finishInitialRead: ((response: { path: string; content: string }) => void) | undefined;
    const readMarkdownFile = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishInitialRead = resolve; }))
      .mockResolvedValue({ path, content: "# Current source" });
    const desktopApi = { readMarkdownFile };
    const initial = context(true);
    const renderViewer = (fileViewerContext: MarkdownFileViewerContext) => (
      <ThreadMarkdown desktopApi={desktopApi} fileViewerContext={fileViewerContext} text={`[report](${path})`} />
    );
    const view = render(renderViewer(initial));
    fireEvent.click(screen.getByRole("link", { name: "report" }));
    expect(readMarkdownFile).toHaveBeenCalledTimes(1);
    const next = {
      ...initial,
      thread: {
        backend: changed === "backend" ? "acp:grok" as const : initial.thread!.backend,
        threadId: changed === "thread" ? "another-reader" : initial.thread!.threadId,
      },
      federationTarget: { scope: "remote" as const, instanceId: changed === "owner" ? "another-owner" : "owner" },
    };
    view.rerender(renderViewer(next));
    await screen.findByRole("heading", { name: "Current source" });
    expect(readMarkdownFile).toHaveBeenCalledTimes(2);
    expect(readMarkdownFile).toHaveBeenLastCalledWith({ path, thread: next.thread, federationTarget: next.federationTarget });
    await act(async () => finishInitialRead!({ path, content: "# Stale source" }));
    expect(screen.queryByRole("heading", { name: "Stale source" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current source" })).toBeInTheDocument();
  });

  it.each([false, true])("preserves modal DOM, selection, scroll and nested viewers across snapshot refreshes (remote: %s)", async (remote) => {
    const readMarkdownFile = vi.fn(async (request: { path: string }) => ({
      path: request.path,
      content: request.path === path ? content : "# Nested\n\nNested document.",
    }));
    const openMarkdownFileViewer = vi.fn(async () => ({ opened: true as const }));
    const viewer = (title = "Reader") => (
      <ThreadMarkdown
        desktopApi={{ readMarkdownFile, openMarkdownFileViewer }}
        fileViewerContext={{ ...context(remote), title: `Files - ${title}`, threadTitle: title }}
        skills={[]}
        text={`[report](${path})`}
      />
    );
    const view = render(viewer());
    fireEvent.click(screen.getByRole("link", { name: "report" }));
    await screen.findByRole("heading", { name: "Report" });
    const dialog = screen.getByRole("dialog", { name: "Markdown document: report" });
    const saved = selectDocument(dialog, ".markdown-document-modal__body");

    // Queue addition, immediate removal, and the next retry each refresh the
    // navigation snapshot. The selected thread's identity is unchanged.
    for (const title of ["Reader", "Reader", "Renamed reader"]) {
      await act(async () => view.rerender(viewer(title)));
      expectDocumentPreserved(saved);
      expect(readMarkdownFile).toHaveBeenCalledTimes(1);
    }

    fireEvent.click(within(dialog).getByRole("button", { name: "Open in detached files window" }));
    expect(openMarkdownFileViewer).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ threadTitle: "Renamed reader" }),
    }));

    fireEvent.click(within(dialog).getByRole("link", { name: "nested report" }));
    await screen.findByRole("heading", { name: "Nested" });
    const nested = screen.getByRole("dialog", { name: "Markdown document: nested report" });
    await act(async () => view.rerender(viewer()));
    expect(nested).toBeInTheDocument();
    expect(readMarkdownFile).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("preserves a detached document across equivalent snapshots and still loads a newly selected file (remote: %s)", async (remote) => {
    window.location.hash = "#files/codex%3Areader";
    const snapshot = (): MarkdownFileViewerSnapshot => ({
      context: context(remote),
      files: [{ path, label: "report" }, { path: "/repo/other.md", label: "other" }],
      selectedPath: path,
    });
    let notify: ((response: { snapshot?: MarkdownFileViewerSnapshot }) => void) | undefined;
    const readMarkdownFile = vi.fn(async (request: { path: string }) => ({
      path: request.path,
      content: request.path === path ? content : "# Other",
    }));
    (window as Window & { pwragent?: DesktopApi }).pwragent = {
      readMarkdownFile,
      readMarkdownFileViewerSnapshot: async () => ({ snapshot: snapshot() }),
      onMarkdownFileViewerSnapshotChanged: (listener) => {
        notify = listener;
        return () => undefined;
      },
    };
    const { container } = render(<MarkdownFilesWindow />);
    await screen.findByRole("heading", { name: "Report" });
    const saved = selectDocument(container, ".markdown-files-window__markdown-scroll");
    for (let retry = 0; retry < 3; retry += 1) {
      await act(async () => notify!({ snapshot: snapshot() }));
      expectDocumentPreserved(saved);
      expect(readMarkdownFile).toHaveBeenCalledTimes(1);
    }
    fireEvent.click(screen.getByRole("button", { name: /other/ }));
    await screen.findByRole("heading", { name: "Other" });
    expect(readMarkdownFile).toHaveBeenCalledTimes(2);
    expect(readMarkdownFile).toHaveBeenLastCalledWith({
      path: "/repo/other.md",
      thread: context().thread,
      ...(remote ? { federationTarget: context(true).federationTarget } : {}),
    });
  });
});
