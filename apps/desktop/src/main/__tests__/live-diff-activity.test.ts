import { describe, expect, it, vi } from "vitest";
import { RENDERER_PAYLOAD_STRING_LIMIT_CHARS } from "@pwragent/shared";
import { buildLiveDiffActivityEntry } from "../app-server/live-diff-activity";

describe("live diff activity normalization", () => {
  it("splits a live unified diff into pre-shaped per-file activity details", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T12:00:00.000Z"));

    const diff = [
      "diff --git a/src/one.ts b/src/one.ts",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,2 +1,2 @@",
      "-old one",
      "+new one",
      " context",
      "diff --git a/src/two.ts b/src/two.ts",
      "--- a/src/two.ts",
      "+++ b/src/two.ts",
      "@@ -1,1 +1,2 @@",
      " existing",
      "+new two",
    ].join("\n");

    try {
      const entry = buildLiveDiffActivityEntry({
        method: "turn/diff/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          diff,
        },
      });

      expect(entry).toMatchObject({
        type: "activity",
        id: "live-diff-turn-1",
        createdAt: Date.parse("2026-06-17T12:00:00.000Z"),
        summary: "Edited 2 files, +2, -1",
        details: [
          {
            id: "live-diff-turn-1-1",
            kind: "write",
            label: "Update one.ts",
            path: "src/one.ts",
            fileDiff: {
              kind: "update",
              additions: 1,
              removals: 1,
            },
          },
          {
            id: "live-diff-turn-1-2",
            kind: "write",
            label: "Update two.ts",
            path: "src/two.ts",
            fileDiff: {
              kind: "update",
              additions: 1,
              removals: 0,
            },
          },
        ],
      });
      expect(entry?.details[0]?.fileDiff?.diff).toContain("diff --git a/src/one.ts");
      expect(entry?.details[1]?.fileDiff?.diff).toContain("diff --git a/src/two.ts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies add and delete diffs from /dev/null headers", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,1 @@",
      "+created",
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-removed",
    ].join("\n");

    const entry = buildLiveDiffActivityEntry({
      method: "turn/diff/updated",
      params: {
        threadId: "thread-1",
        diff,
      },
    });

    expect(entry?.id).toBe("live-diff-thread-1");
    expect(entry?.summary).toBe("Edited 2 files, +1, -1");
    expect(entry?.details.map((detail) => detail.fileDiff?.kind)).toEqual([
      "add",
      "delete",
    ]);
    expect(entry?.details.map((detail) => detail.label)).toEqual([
      "Add new.ts",
      "Delete old.ts",
    ]);
  });

  it("caps aggregate inline diff text across many small file sections", () => {
    const sections = Array.from({ length: 80 }, (_, index) => {
      const fileName = `src/file-${index}.ts`;
      const addedLine = `+${"x".repeat(700)}`;
      return [
        `diff --git a/${fileName} b/${fileName}`,
        `--- a/${fileName}`,
        `+++ b/${fileName}`,
        "@@ -1,1 +1,2 @@",
        " existing",
        addedLine,
      ].join("\n");
    });
    const entry = buildLiveDiffActivityEntry({
      method: "turn/diff/updated",
      params: {
        threadId: "thread-large",
        turnId: "turn-large",
        diff: sections.join("\n"),
      },
    });

    const totalInlineDiffChars =
      entry?.details.reduce(
        (total, detail) => total + (detail.fileDiff?.diff.length ?? 0),
        0,
      ) ?? 0;
    const omittedDetails =
      entry?.details.filter((detail) => detail.fileDiff?.omittedReason) ?? [];

    expect(entry?.details).toHaveLength(80);
    expect(entry?.summary).toBe("Edited 80 files, +80, -0");
    expect(totalInlineDiffChars).toBeLessThanOrEqual(
      RENDERER_PAYLOAD_STRING_LIMIT_CHARS,
    );
    expect(omittedDetails.length).toBeGreaterThan(0);
    expect(omittedDetails[0]?.fileDiff).toMatchObject({
      diff: "",
      omittedReason: expect.stringContaining("cumulative diff exceeds"),
    });
  });
});
