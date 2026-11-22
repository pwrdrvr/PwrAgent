import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReadMarkdownFileViewerSnapshotResponse } from "@pwragent/shared/contracts/settings";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { MarkdownFilesWindow } from "../MarkdownFilesWindow";

const context = { key: "decision-results:/results", title: "Decision batch results" };
const file = { path: "/results/batch_fixture.jsonl", label: "batch_fixture.jsonl" };

function resultsSnapshot(openSequence: number) {
  return { snapshot: { context, files: [file], selectedPath: file.path, openSequence } };
}

afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: DesktopApi }).pwragent;
  window.location.hash = "";
});

async function checkAppendsOnReopen(values: number[], pendingFirstRead = false) {
  window.location.hash = `#files/${encodeURIComponent(context.key)}`;
  let notify!: (response: ReadMarkdownFileViewerSnapshotResponse) => void;
  let completeFirstRead!: () => void;
  let content = '{"type":"batch"}\n';
  const readMarkdownFile = vi.fn(async () => ({ path: file.path, content }));
  if (pendingFirstRead) {
    readMarkdownFile.mockImplementationOnce(() => new Promise((resolve) => {
      const original = content;
      completeFirstRead = () => resolve({ path: file.path, content: original });
    }));
  }
  (window as Window & { pwragent?: DesktopApi }).pwragent = {
    readMarkdownFile,
    readMarkdownFileViewerSnapshot: async () => resultsSnapshot(1),
    onMarkdownFileViewerSnapshotChanged: (listener) => {
      notify = listener;
      return () => undefined;
    },
  };

  try {
    await act(async () => { render(<MarkdownFilesWindow />); });
    expect(readMarkdownFile).toHaveBeenCalledTimes(1);
    if (!pendingFirstRead) {
      expect(screen.getByRole("region", { name: "JSON Lines contents" }).textContent).toBe(content.trim());
    }
    for (const [index, value] of values.entries()) {
      content += `${JSON.stringify({ type: "item", index, value })}\n`;
      await act(async () => notify(resultsSnapshot(index + 2)));
      expect(readMarkdownFile).toHaveBeenCalledTimes(index + 2);
      expect(screen.getByRole("region", { name: "JSON Lines contents" }).textContent).toBe(content.replaceAll("\n", ""));
    }
    if (pendingFirstRead) {
      await act(async () => completeFirstRead());
      expect(screen.getByRole("region", { name: "JSON Lines contents" }).textContent).toBe(content.replaceAll("\n", ""));
    }
  } finally {
    cleanup();
  }
}

describe("reopening results in the Files window", () => {
  it("shows an appended item when the operator reopens the same path", async () => {
    await checkAppendsOnReopen([0]);
  });

  it("keeps the latest open when the initial snapshot resolves late", async () => {
    window.location.hash = `#files/${encodeURIComponent(context.key)}`;
    let notify!: (response: ReadMarkdownFileViewerSnapshotResponse) => void;
    let finishInitialSnapshot!: (response: ReadMarkdownFileViewerSnapshotResponse) => void;
    const readMarkdownFile = vi.fn(async () => ({ path: file.path, content: '{"type":"batch"}\n' }));
    (window as Window & { pwragent?: DesktopApi }).pwragent = {
      readMarkdownFile,
      readMarkdownFileViewerSnapshot: () => new Promise((resolve) => { finishInitialSnapshot = resolve; }),
      onMarkdownFileViewerSnapshotChanged: (listener) => {
        notify = listener;
        return () => undefined;
      },
    };

    render(<MarkdownFilesWindow />);
    await act(async () => notify(resultsSnapshot(2)));
    expect(readMarkdownFile).toHaveBeenCalledTimes(1);
    await act(async () => finishInitialSnapshot(resultsSnapshot(1)));
    expect(readMarkdownFile).toHaveBeenCalledTimes(1);
  });

  it("loads the current results after arbitrary appends and ignores an older pending read", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer(), { minLength: 1, maxLength: 4 }),
      fc.boolean(),
      checkAppendsOnReopen,
    ), { numRuns: 25 });
  });
});
