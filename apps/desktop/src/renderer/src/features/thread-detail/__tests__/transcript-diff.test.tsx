import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    diff: ELIGIBLE_DIFF
  }
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
      decisions: []
    }));
    (window as Window & { pwragent?: unknown }).pwragent = {
      analyzeFocusedDiff
    };

    render(<TranscriptDiff detail={DETAIL} />);

    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    await screen.findByText("1 hunk hidden, 5 lines skipped");
    expect(screen.queryByText("// refreshed comment")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
    expect(screen.getByText("// refreshed comment")).toBeInTheDocument();
    expect(analyzeFocusedDiff).toHaveBeenCalledTimes(1);
  });

  it("falls back to deterministic condensation when focused analysis fails", async () => {
    const analyzeFocusedDiff = vi.fn(async () => {
      throw new Error("network down");
    });
    (window as Window & { pwragent?: unknown }).pwragent = {
      analyzeFocusedDiff
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
});
