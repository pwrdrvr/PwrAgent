import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadMarkdownFileRequest } from "@pwragent/shared";
import { ThreadMarkdown } from "../ThreadMarkdown";

afterEach(cleanup);

// A displayed document belongs to its file/thread/owner, not to the current
// transport callback. Connection churn must preserve its DOM and read budget.
async function checkConnectionChanges(changes: boolean[], pending: boolean) {
  let finishRead!: (response: { path: string; content: string }) => void;
  const read = vi.fn((_request: ReadMarkdownFileRequest) => new Promise<{ path: string; content: string }>((resolve) => {
    finishRead = resolve;
  }));
  const viewer = (connected: boolean) => (
    <ThreadMarkdown
      desktopApi={connected ? { readMarkdownFile: (request) => read(request) } : undefined}
      fileViewerContext={{
        key: "remote:owner:reader",
        title: "Files",
        thread: { backend: "codex", threadId: "reader" },
        federationTarget: { scope: "remote", instanceId: "owner" },
      }}
      text="[report](/repo/report.md)"
    />
  );
  const view = render(viewer(true));
  try {
    fireEvent.click(screen.getByRole("link", { name: "report" }));
    const complete = async () => {
      await act(async () => finishRead({ path: "/repo/report.md", content: "# Retained report" }));
    };
    if (!pending) await complete();
    const heading = pending ? undefined : screen.getByRole("heading", { name: "Retained report" });
    const selection = window.getSelection()!;
    if (heading) {
      const range = document.createRange();
      range.selectNodeContents(heading);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const scroll = view.baseElement.querySelector<HTMLElement>(".markdown-document-modal__body")!;
    scroll.scrollTop = 640;
    for (const connected of changes) {
      await act(async () => view.rerender(viewer(connected)));
      expect(read).toHaveBeenCalledTimes(1);
      if (heading) {
        expect(screen.getByRole("heading", { name: "Retained report" })).toBe(heading);
        expect(scroll.scrollTop).toBe(640);
        expect(selection.toString()).toBe("Retained report");
        expect(screen.queryByText("Loading file…")).not.toBeInTheDocument();
      }
    }
    if (pending) await complete();
    expect(screen.getByRole("heading", { name: "Retained report" })).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    window.getSelection()?.removeAllRanges();
    view.unmount();
  }
}

describe("document connection stability", () => {
  it("keeps an already displayed remote file through a disconnect and reconnect", async () => {
    await checkConnectionChanges([false, true], false);
  });

  it("keeps loaded and pending reads across arbitrary connection and API changes", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
      fc.boolean(),
      async (changes, pending) => checkConnectionChanges(changes, pending),
    ), { numRuns: 25 });
  });
});
