import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcriptFileReference, type AppServerThreadSummary } from "@pwragent/shared";
import { resolveTranscriptFiles, transcriptThreadDirectories } from "../transcript-files";

describe("transcript file resolution", () => {
  let root: string;
  beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), "transcript-files-"))); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("stats relative, absolute, spaced and extensionless filenames without reading their contents", async () => {
    await mkdir(path.join(root, "research"));
    for (const name of ["research/NOTES.md", "hello world.md", "README", "code.ts", "literal%20.md"]) {
      await writeFile(path.join(root, name), "fixture");
    }
    const absolute = path.join(root, "hello world.md");
    const result = await resolveTranscriptFiles({ references: [
      "research/NOTES.md:12:3", "research/NOTES.md:12:3", absolute, "README", "code.ts", "literal%20.md", "missing.md", "research", "seek(t)",
    ] }, [root]);
    expect(result.files).toEqual([
      { reference: "research/NOTES.md:12:3", path: path.join(root, "research/NOTES.md"), line: 12, column: 3, previewable: true },
      { reference: absolute, path: absolute, previewable: true },
      { reference: "README", path: path.join(root, "README"), previewable: false },
      { reference: "code.ts", path: path.join(root, "code.ts"), previewable: false },
      { reference: "literal%20.md", path: path.join(root, "literal%20.md"), previewable: true },
    ]);
    expect(await resolveTranscriptFiles({ references: ["code.ts"] }, [])).toEqual({ files: [] });
  });

  it("keeps preview gates on symlink destinations and scopes stat to authorized real directories", async () => {
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(path.join(project, ".env"), "SECRET=fixture");
    await symlink(path.join(project, ".env"), path.join(project, "notes.md"));
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(project, "escape.md"));
    expect(await resolveTranscriptFiles({ references: ["notes.md", "escape.md", "../outside.md"] }, [project], true))
      .toEqual({ files: [{ reference: "notes.md", path: path.join(project, "notes.md"), previewable: false }] });
  });

  it("recognizes Windows paths and positive location suffixes while rejecting commands and URLs", () => {
    expect(transcriptFileReference(String.raw`C:\project\notes.md:4:2`))
      .toEqual({ path: String.raw`C:\project\notes.md`, line: 4, column: 2 });
    for (const value of ["PATH", "main", "#000000", "seek(t)", "npm install", "https://example.com/a.md", "$(cat notes.md)", "notes.md:0", "notes.md:9999999999999999999"]) {
      expect(transcriptFileReference(value)).toBeUndefined();
    }
  });

  it("bounds the owner-side batch", async () => {
    await expect(resolveTranscriptFiles({ references: Array(129).fill("notes.md") }, [root])).rejects.toThrow("128");
  });

  it("uses the active worktree when there is no project key", () => {
    expect(transcriptThreadDirectories({ linkedDirectories: [
      { id: "directory", label: "Project", kind: "worktree", path: "/repo", worktreePath: "/worktree" },
    ] } as AppServerThreadSummary)).toEqual(["/worktree", "/repo"]);
  });
});
