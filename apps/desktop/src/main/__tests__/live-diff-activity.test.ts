import { describe, expect, it, vi } from "vitest";
import {
  buildLiveDiffActivityEntry,
  getLiveThreadFileDiff,
} from "../app-server/live-diff-activity";

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
      expect(entry?.details[0]?.fileDiff?.diff).toBe("");
      expect(entry?.details[1]?.fileDiff?.diff).toBe("");
      expect(
        getLiveThreadFileDiff(entry!.details[0]!.fileDiff!.diffRef!),
      ).toContain("diff --git a/src/one.ts");
      expect(
        getLiveThreadFileDiff(entry!.details[1]!.fileDiff!.diffRef!),
      ).toContain("diff --git a/src/two.ts");
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

    expect(entry?.id).toMatch(/^live-diff-thread-1-\d+$/);
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

  it("uses unique live diff refs when turn id is omitted", () => {
    const firstDiff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,1 +1,1 @@",
      "-first",
      "+first updated",
    ].join("\n");
    const secondDiff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,1 +1,1 @@",
      "-second",
      "+second updated",
    ].join("\n");

    const first = buildLiveDiffActivityEntry({
      method: "turn/diff/updated",
      params: {
        threadId: "thread-no-turn",
        diff: firstDiff,
      },
    });
    const second = buildLiveDiffActivityEntry({
      method: "turn/diff/updated",
      params: {
        threadId: "thread-no-turn",
        diff: secondDiff,
      },
    });

    expect(first?.id).not.toBe(second?.id);
    const firstRef = first?.details[0]?.fileDiff?.diffRef;
    const secondRef = second?.details[0]?.fileDiff?.diffRef;
    expect(firstRef?.key).not.toBe(secondRef?.key);
    expect(firstRef ? getLiveThreadFileDiff(firstRef) : undefined).toContain(
      "first updated",
    );
    expect(secondRef ? getLiveThreadFileDiff(secondRef) : undefined).toContain(
      "second updated",
    );
  });

  it("keeps large live diff text behind refs instead of embedding it in events", () => {
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

    expect(entry?.details).toHaveLength(80);
    expect(entry?.summary).toBe("Edited 80 files, +80, -0");
    expect(entry?.details.every((detail) => detail.fileDiff?.diff === "")).toBe(
      true,
    );
    expect(entry?.details[0]?.fileDiff).toMatchObject({
      diff: "",
      diffRef: expect.objectContaining({
        source: "live",
        threadId: "thread-large",
        entryId: "live-diff-turn-large",
        detailId: "live-diff-turn-large-1",
      }),
    });
    expect(
      getLiveThreadFileDiff(entry!.details[0]!.fileDiff!.diffRef!),
    ).toContain("diff --git a/src/file-0.ts");
  });
});
