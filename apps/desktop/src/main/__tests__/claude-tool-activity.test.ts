import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeFileDiff, claudeTodoSteps, claudeToolDetail, claudeTurnDiff } from "../claude/claude-tool-activity";

describe("Claude tool activity", () => {
  it("names a file outside the workspace by its full path in the diff", () => {
    const outside = path.join(path.parse(process.cwd()).root, "elsewhere", "file.txt");
    const edit = claudeFileDiff({
      filePath: outside, structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 2, lines: [" a", "+b"] }],
    }, path.join(path.parse(process.cwd()).root, "workspace"));
    expect(edit?.diff.split("\n")[0]).toBe("diff --git a/elsewhere/file.txt b/elsewhere/file.txt");
    expect(edit?.fileDiff).toMatchObject({ kind: "update", additions: 1, removals: 0 });
  });

  it("keeps a large diff's counts but not its text", () => {
    const lines = Array.from({ length: 30_000 }, (_, index) => `+line ${index} ${"x".repeat(20)}`);
    const edit = claudeFileDiff({
      type: "create", filePath: "/w/big.txt", structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }],
    }, "/w");
    expect(edit).toMatchObject({ diff: "", fileDiff: { kind: "add", diff: "", additions: 30_000, omittedReason: expect.any(String) } });
  });

  it("ignores results that are not file edits", () => {
    expect(claudeFileDiff("The file has been updated.", "/w")).toBeUndefined();
    expect(claudeFileDiff({ filePath: "/w/a", structuredPatch: [{ lines: "nope" }] }, "/w")).toBeUndefined();
    expect(claudeFileDiff({ filePath: "/w/a", structuredPatch: [] }, "/w")).toBeUndefined();
  });

  it("maps todos to plan steps and drops malformed ones", () => {
    expect(claudeTodoSteps({ todos: [
      { content: "Do it", status: "in_progress" }, { content: "", status: "pending" }, { content: "Later", status: "blocked" }, null,
    ] })).toEqual([{ step: "Do it", status: "in_progress" }, { step: "Later", status: "pending" }]);
    expect(claudeTodoSteps({})).toBeUndefined();
  });

  it("leaves other tools, and calls missing their target, to the generic row", () => {
    expect(claudeToolDetail({ id: "1", name: "Skill", input: { skill: "x" }, status: "in_progress" })).toBeUndefined();
    expect(claudeToolDetail({ id: "1", name: "Read", input: {}, status: "in_progress" })).toBeUndefined();
    expect(claudeToolDetail({ id: "1", name: "Glob", input: { pattern: "**/*.ts" }, status: "completed" }))
      .toEqual({ id: "1", kind: "read", label: "Listed **/*.ts", status: "completed" });
  });

  it("keeps one section per file in a turn diff, in first-edit order", () => {
    const a1 = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n-1\n+2";
    const b = "diff --git a/b b/b\n--- /dev/null\n+++ b/b\n@@ -0,0 +1,1 @@\n+new";
    const a2 = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n-2\n+3";
    expect(claudeTurnDiff([a1, b, a2])).toBe([
      "diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,1 +1,1 @@", "-1", "+2", "@@ -1,1 +1,1 @@", "-2", "+3",
      "diff --git a/b b/b", "--- /dev/null", "+++ b/b", "@@ -0,0 +1,1 @@", "+new",
    ].join("\n"));
  });
});
