import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppServerThreadFileDiffRef } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptDiff } from "../TranscriptDiff";

const ELIGIBLE_DIFF = [
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,7 +1,7 @@",
  " import { alpha } from './alpha';",
  "-import { beta } from './beta';",
  "+import { beta } from './beta/index';",
  " const keep = 1;",
  " const keep2 = 2;",
  " const keep3 = 3;",
  " const keep4 = 4;",
  "@@ -18,7 +18,7 @@",
  " function one() {",
  "   return keep;",
  "-  // old comment",
  "+  // refreshed comment",
  " }",
  " ",
  " export function two() {",
  "@@ -34,7 +34,7 @@",
  " export function three() {",
  "   return 'three';",
  "-  const label = 'before';",
  "+  const label = 'after';",
  "   return label;",
  " }",
  " ",
  " export function four() {",
  "@@ -50,7 +50,7 @@",
  " export function five() {",
  "   return 'five';",
  "-  // lint",
  "+  // linted",
  " }",
  " ",
  " export const six = 6;",
].join("\n");

const DETAIL = {
  id: "detail-1",
  kind: "write" as const,
  label: "Update example.ts",
  path: "/repo/src/example.ts",
  fileDiff: {
    kind: "update" as const,
    additions: 4,
    removals: 4,
    diff: ELIGIBLE_DIFF,
  },
};

describe("TranscriptDiff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as Window & { pwragent?: unknown }).pwragent;
  });

  it("defaults to a focused view when analysis hides low-signal hunks", async () => {
    const analyzeFocusedDiff = vi.fn(async () => ({
      mode: "focused" as const,
      source: "grok" as const,
      hiddenHunkIndices: [1],
      hiddenHunkCount: 1,
      decisions: [],
    }));
    (window as Window & { pwragent?: unknown }).pwragent = {
      analyzeFocusedDiff,
    };

    render(<TranscriptDiff detail={DETAIL} />);

    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    await screen.findByText("1 hunk hidden, 5 lines skipped");
    expect(screen.queryByText("// refreshed comment")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(
      screen.getByRole("button", { name: "Zoom out" }),
    ).toBeInTheDocument();
    expect(screen.getByText("// refreshed comment")).toBeInTheDocument();
    expect(analyzeFocusedDiff).toHaveBeenCalledTimes(1);
  });

  it("falls back to deterministic condensation when focused analysis fails", async () => {
    const analyzeFocusedDiff = vi.fn(async () => {
      throw new Error("network down");
    });
    (window as Window & { pwragent?: unknown }).pwragent = {
      analyzeFocusedDiff,
    };

    render(<TranscriptDiff detail={DETAIL} />);

    await waitFor(() => {
      expect(analyzeFocusedDiff).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    expect(screen.getByText("6 lines skipped")).toBeInTheDocument();
    expect(screen.queryByText("const keep3 = 3;")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(screen.getByText("const keep3 = 3;")).toBeInTheDocument();
  });

  it("renders omitted large diffs without focused analysis", () => {
    const analyzeFocusedDiff = vi.fn();
    (window as Window & { pwragent?: unknown }).pwragent = {
      analyzeFocusedDiff,
    };

    render(
      <TranscriptDiff
        detail={{
          ...DETAIL,
          fileDiff: {
            kind: "delete",
            additions: 0,
            removals: 3,
            diff: "",
            omittedReason:
              "Large file diff omitted from transcript view (518 KB).",
            originalLength: 530_180,
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        "Large file diff omitted from transcript view (518 KB).",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Zoom in" }),
    ).not.toBeInTheDocument();
    expect(analyzeFocusedDiff).not.toHaveBeenCalled();
  });

  it("fetches referenced live diff text only when the diff component renders", async () => {
    const getThreadFileDiff = vi.fn(async () => ({ diff: ELIGIBLE_DIFF }));
    (window as Window & { pwragent?: unknown }).pwragent = {
      getThreadFileDiff,
    };
    const diffRef = {
      source: "live" as const,
      key: "live:thread-1:entry-1:detail-1",
      threadId: "thread-1",
      entryId: "entry-1",
      detailId: "detail-1",
    };

    render(
      <TranscriptDiff
        detail={{
          ...DETAIL,
          fileDiff: {
            ...DETAIL.fileDiff,
            diff: "",
            diffRef,
          },
        }}
      />,
    );

    expect(screen.getByText("Loading diff...")).toBeInTheDocument();
    await screen.findByText(/beta\/index/);
    expect(getThreadFileDiff).toHaveBeenCalledWith({ ref: diffRef });
  });

  it("fetches and stacks multiple referenced diff chunks for merged rows", async () => {
    const firstDiff = ["@@ -1,1 +1,2 @@", " alpha", "+beta"].join("\n");
    const secondDiff = ["@@ -4,1 +5,2 @@", " gamma", "+delta"].join("\n");
    const refs: AppServerThreadFileDiffRef[] = [
      {
        source: "thread" as const,
        key: "thread:thread-1:entry-1:detail-1",
        backend: "codex" as const,
        threadId: "thread-1",
        entryId: "entry-1",
        detailId: "detail-1",
      },
      {
        source: "thread" as const,
        key: "thread:thread-1:entry-2:detail-1",
        backend: "codex" as const,
        threadId: "thread-1",
        entryId: "entry-2",
        detailId: "detail-1",
      },
    ];
    const getThreadFileDiff = vi.fn(
      async ({ ref }: { ref: AppServerThreadFileDiffRef }) => ({
        diff: ref.key.endsWith("entry-1:detail-1") ? firstDiff : secondDiff,
      }),
    );
    (window as Window & { pwragent?: unknown }).pwragent = {
      getThreadFileDiff,
    };

    render(
      <TranscriptDiff
        detail={{
          ...DETAIL,
          fileDiff: {
            ...DETAIL.fileDiff,
            diff: "",
            diffRef: refs[1],
            diffRefs: refs,
            additions: 2,
            removals: 0,
          },
        }}
      />,
    );

    await screen.findByText("beta");
    expect(screen.getByText("delta")).toBeInTheDocument();
    expect(getThreadFileDiff).toHaveBeenCalledTimes(2);
    expect(getThreadFileDiff).toHaveBeenNthCalledWith(1, { ref: refs[0] });
    expect(getThreadFileDiff).toHaveBeenNthCalledWith(2, { ref: refs[1] });
  });
});
