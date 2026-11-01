import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeArtifactResult, claudeArtifactShowsOutput, claudeFileDiff, claudeTodoSteps, claudeToolDetail, claudeTurnDiff,
} from "../claude/claude-tool-activity";

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

  it("names artifact calls, linking to the page they name", () => {
    const detail = (name: string, input: Record<string, unknown>) =>
      claudeToolDetail({ id: "1", name, input, status: "in_progress" });
    const page = "https://claude.ai/artifact/DEUQW4g8qq7csZHvDLZKyt";
    // A publish takes the action by default, and never the source as its path.
    expect(detail("Artifact", { file_path: "/w/settings.html", title: "Settings screen" }))
      .toEqual({ id: "1", kind: "write", label: "Published Settings screen", status: "in_progress" });
    expect(detail("Artifact", { file_path: "/w/settings.html" })).toMatchObject({ label: "Published settings.html" });
    expect(detail("Artifact", { action: "publish", type: "design" })).toMatchObject({ label: "Published an artifact" });
    expect(detail("Artifact", { action: "quickstart", intent: "design" })).toMatchObject({ kind: "read", label: "Read how to start an artifact" });
    expect(detail("Artifact", { action: "list", limit: 3 })).toEqual({ id: "1", kind: "read", label: "Listed artifacts", status: "in_progress" });
    expect(detail("Artifact", { action: "read", url: page })).toMatchObject({ kind: "read", label: "Read an artifact", url: page });
    // A deleted artifact's link no longer opens.
    expect(detail("Artifact", { action: "delete", url: page })).toEqual({
      id: "1", kind: "write", label: "Deleted an artifact", status: "in_progress",
    });
    expect(detail("ArtifactComments", { action: "read", url: page })).toMatchObject({ kind: "read", label: "Read artifact comments", url: page });
    expect(detail("ArtifactComments", { action: "reply", url: page })).toMatchObject({ kind: "write", label: "Replied to an artifact comment" });
    expect(detail("ArtifactData", { action: "list", url: page, collection: "notes" })).toMatchObject({ kind: "read", label: "Read artifact data" });
    expect(detail("ArtifactData", { action: "delete", url: page, collection: "notes" })).toMatchObject({ kind: "write", label: "Wrote artifact data" });
    // Only an https link is offered, and an unlisted action keeps the generic row.
    expect(detail("Artifact", { action: "read", url: "javascript:alert(1)" })).not.toHaveProperty("url");
    expect(detail("Artifact", { action: "watch", url: page })).toBeUndefined();
  });

  it("shows the operator only the artifact results written for them", () => {
    const page = { url: "https://claude.ai/artifact/x", title: "Deck" };
    expect(["list", "comments", "read_db", "read_asset"].every((action) => claudeArtifactShowsOutput(action, {}))).toBe(true);
    expect(claudeArtifactShowsOutput("quickstart", {})).toBe(false);
    expect(claudeArtifactShowsOutput("publish", page)).toBe(false);
    expect(claudeArtifactShowsOutput("read", { read: page })).toBe(false);
    expect(claudeArtifactShowsOutput("delete", { artifact_delete: { url: page.url, deleted: true } })).toBe(false);
    // A result that does not confirm the row keeps the text that explains it.
    expect(claudeArtifactShowsOutput("publish", undefined)).toBe(true);
    expect(claudeArtifactShowsOutput("read", { read: {} })).toBe(true);
    expect(claudeArtifactShowsOutput("delete", { artifact_delete: { url: page.url, deleted: false } })).toBe(true);
  });

  it("names the page a publish or read returned", () => {
    const published = { id: "1", kind: "write" as const, label: "Published settings.html", status: "in_progress" as const };
    // Captured from Claude Code 2.1.303's publish result.
    expect(claudeArtifactResult(published, "publish", {
      url: "https://claude.ai/artifact/DEUQW4g8qq7csZHvDLZKyt", path: "/w/settings.html",
      artifact_id: "630f38d3-9e88-4301-bf28-0d6e5f81bd5b", title: "Settings screen", owned: true, audience: "owner",
    })).toEqual({ ...published, label: "Published Settings screen", url: "https://claude.ai/artifact/DEUQW4g8qq7csZHvDLZKyt" });
    // A publish that creates the artifact from a type names no source file.
    expect(claudeArtifactResult(published, "publish", { url: "https://claude.ai/artifact/UJ29qnGYNBbYgJY1TAEkoW" }))
      .toEqual({ ...published, url: "https://claude.ai/artifact/UJ29qnGYNBbYgJY1TAEkoW" });
    const read = { id: "2", kind: "read" as const, label: "Read an artifact" };
    expect(claudeArtifactResult(read, "read", { read: { url: "https://claude.ai/artifact/x", title: "Deck", code: 200, result: "<html>" } }))
      .toEqual({ ...read, label: "Read Deck", url: "https://claude.ai/artifact/x" });
    expect(claudeArtifactResult(read, "list", { artifacts: [], total: 0 })).toBeUndefined();
    expect(claudeArtifactResult(read, "delete", { artifact_delete: { url: "https://claude.ai/artifact/x", deleted: true } })).toBeUndefined();
    expect(claudeArtifactResult(read, "pin", { url: "https://claude.ai/artifact/x" })).toBeUndefined();
    expect(claudeArtifactResult(published, "publish", "Published")).toBeUndefined();
    expect(claudeArtifactResult(published, "publish", { url: "http://claude.ai/artifact/x" })).toBeUndefined();
    expect(claudeArtifactResult(published, "publish", { url: "https://user:secret@claude.ai/artifact/x" })).toBeUndefined();
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
