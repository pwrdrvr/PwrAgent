import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcriptFileReference } from "@pwragent/shared/transcript-file-reference";
import { type AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import {
  isThreadWorkspaceFile,
  resolveTranscriptFiles,
  transcriptThreadDirectories,
} from "../transcript-files";

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

  it("counts a file as the thread's own work only in its directories or a Claude scratchpad for them", async () => {
    const worktree = path.join(root, "work.tree");
    const tmpRoot = path.join(root, "tmp");
    const sessions = path.join(tmpRoot, "claude-501", worktree.replace(/[^a-zA-Z0-9]/g, "-"));
    const files = {
      inWorktree: path.join(worktree, "docs", "review.html"),
      worktreeSibling: path.join(root, "work.tree-other", "review.html"),
      ownScratchpad: path.join(sessions, "thread-1", "scratchpad", "pa", "review.html"),
      // A rewound, restarted or forked thread runs under a new session id.
      newSessionScratchpad: path.join(sessions, "8d1c-rewound", "scratchpad", "review.html"),
      ownSessionOutsideScratchpad: path.join(sessions, "thread-1", "tasks", "review.html"),
      otherProjectScratchpad: path.join(tmpRoot, "claude-501", "-elsewhere", "thread-1", "scratchpad", "review.html"),
      otherUser: path.join(tmpRoot, "claude-502", worktree.replace(/[^a-zA-Z0-9]/g, "-"), "thread-1", "scratchpad", "review.html"),
    };
    for (const file of Object.values(files)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "<p>fixture</p>");
    }
    const thread = (source: string) => ({
      id: "thread-1",
      source,
      projectKey: worktree,
      linkedDirectories: [],
    }) as unknown as AppServerThreadSummary;
    const expected: Record<keyof typeof files, [claude: boolean, codex: boolean]> = {
      inWorktree: [true, true],
      worktreeSibling: [false, false],
      ownScratchpad: [true, false],
      newSessionScratchpad: [true, false],
      ownSessionOutsideScratchpad: [false, false],
      otherProjectScratchpad: [false, false],
      otherUser: [false, false],
    };
    for (const [name, file] of Object.entries(files) as Array<[keyof typeof files, string]>) {
      const [claude, codex] = expected[name];
      expect(await isThreadWorkspaceFile(file, thread("claude"), { tmpRoot, uid: 501 }), `${name} claude`).toBe(claude);
      expect(await isThreadWorkspaceFile(file, thread("codex"), { tmpRoot, uid: 501 }), `${name} codex`).toBe(codex);
    }
  });

  it("uses the active worktree when there is no project key", () => {
    expect(transcriptThreadDirectories({ linkedDirectories: [
      { id: "directory", label: "Project", kind: "worktree", path: "/repo", worktreePath: "/worktree" },
    ] } as AppServerThreadSummary)).toEqual(["/worktree", "/repo"]);
  });
});
