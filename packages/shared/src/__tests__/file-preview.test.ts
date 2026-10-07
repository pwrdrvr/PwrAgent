import { describe, expect, it } from "vitest";
import { filePreviewKind, filePreviewKindLabel, isFilePreviewPath } from "../file-preview";

describe("file preview kinds", () => {
  it.each([
    ["/repo/PLAN.md", "markdown"],
    ["/repo/notes.MARKDOWN", "markdown"],
    ["/repo/package.json", "json"],
    ["/repo/.vscode/settings.jsonc", "json"],
    ["/repo/events.jsonl", "jsonl"],
    ["/repo/events.ndjson", "jsonl"],
    ["/repo/config.yaml", "yaml"],
    ["/repo/config.YML", "yaml"],
    ["/repo/pyproject.toml", "toml"],
    ["/repo/results.csv", "csv"],
    ["/repo/results.tsv", "tsv"],
    ["/repo/notes.txt", "text"],
    ["C:\\repo\\build.log", "text"],
    ["/Users/example/.codex/worktrees/abc/repo/events.jsonl", "jsonl"],
  ])("maps %s to %s", (filePath, kind) => {
    expect(filePreviewKind(filePath)).toBe(kind);
    expect(isFilePreviewPath(filePath)).toBe(true);
  });

  it.each([
    "/repo/src/main.ts",
    "/repo/.env",
    "/repo/production.env",
    "/repo/Makefile",
    "/repo/archive.json.gz",
    "/Users/example/.codex/sessions/2026/10/06/events.jsonl",
    "/Users/example/.codex/archived_sessions/events.jsonl",
    "/Users/example/.codex/history.jsonl",
    "C:\\Users\\example\\.codex\\session_index.jsonl",
    "/tmp/codex-home/sessions/rollout-2026-10-06T12-00-00-abc.jsonl",
  ])("keeps %s editor-first", (filePath) => {
    expect(filePreviewKind(filePath)).toBeUndefined();
    expect(isFilePreviewPath(filePath)).toBe(false);
  });

  it("names each kind for its copy action", () => {
    expect(filePreviewKindLabel("jsonl")).toBe("JSON Lines");
    expect(filePreviewKindLabel("text")).toBe("text");
  });
});
