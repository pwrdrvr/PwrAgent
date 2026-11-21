import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import type { AppServerThreadFileDiffRef } from "@pwragent/shared/contracts/normalized-app-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptDiff } from "../TranscriptDiff";

const MULTI_HUNK_DIFF = [
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
  " export const six = 6;"
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
    diff: MULTI_HUNK_DIFF
  }
};

describe("TranscriptDiff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as Window & { pwragent?: unknown }).pwragent;
  });

  it("renders every hunk and context line in patch order", () => {
    render(<TranscriptDiff detail={DETAIL} />);

    const table = screen.getByRole("table", { name: "Update example.ts diff" });
    const patchRows = MULTI_HUNK_DIFF.split("\n").slice(2);
    expect(within(table).getAllByRole("row").map((row) =>
      row.querySelector("code")?.textContent ?? row.textContent
    )).toEqual(patchRows.map((line) => line.startsWith("@@") ? line : line.slice(1) || " "));
  });

  it("renders omitted large diffs", () => {
    render(
      <TranscriptDiff
        detail={{
          ...DETAIL,
          fileDiff: {
            kind: "delete",
            additions: 0,
            removals: 3,
            diff: "",
            omittedReason: "Large file diff omitted from transcript view (518 KB).",
            originalLength: 530_180
          }
        }}
      />
    );

    expect(
      screen.getByText("Large file diff omitted from transcript view (518 KB).")
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("fetches referenced live diff text only when the diff component renders", async () => {
    const getThreadFileDiff = vi.fn(async () => ({ diff: MULTI_HUNK_DIFF }));
    (window as Window & { pwragent?: unknown }).pwragent = {
      getThreadFileDiff
    };
    const diffRef = {
      source: "live" as const,
      key: "live:thread-1:entry-1:detail-1",
      threadId: "thread-1",
      entryId: "entry-1",
      detailId: "detail-1"
    };

    render(
      <TranscriptDiff
        detail={{
          ...DETAIL,
          fileDiff: {
            ...DETAIL.fileDiff,
            diff: "",
            diffRef
          }
        }}
      />
    );

    expect(screen.getByText("Loading diff...")).toBeInTheDocument();
    await screen.findByText(/beta\/index/);
    expect(screen.getByText("const keep3 = 3;")).toBeInTheDocument();
    expect(getThreadFileDiff).toHaveBeenCalledWith({ ref: diffRef });
  });

  it("fetches and stacks multiple referenced diff chunks for merged rows", async () => {
    const firstDiff = [
      "@@ -1,1 +1,2 @@",
      " alpha",
      "+beta",
    ].join("\n");
    const secondDiff = [
      "@@ -4,1 +5,2 @@",
      " gamma",
      "+delta",
    ].join("\n");
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
    }));
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
      />
    );

    await screen.findByText("beta");
    expect(screen.getByText("delta")).toBeInTheDocument();
    expect(getThreadFileDiff).toHaveBeenCalledTimes(2);
    expect(getThreadFileDiff).toHaveBeenNthCalledWith(1, { ref: refs[0] });
    expect(getThreadFileDiff).toHaveBeenNthCalledWith(2, { ref: refs[1] });
  });
});
