import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { resolveResearchEvidencePath } from "../research/research-evidence-path";

describe("research evidence workspace boundary", () => {
  it("rejects generated traversal and absolute paths before resolving files", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("../secret", "a/../../secret", "/tmp/secret", "a/./file", "a//file", "..\\secret"), async (relative) => {
      await expect(resolveResearchEvidencePath("/unopened-workspace", relative)).rejects.toThrow("Invalid evidence path");
    }));
  });

  it("uses the filesystem as the oracle for in-workspace files and escaping symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "research-evidence-"));
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      await writeFile(path.join(workspace, "evidence.txt"), "Contrived evidence");
      await writeFile(path.join(root, "outside.txt"), "Outside");
      await expect(resolveResearchEvidencePath(workspace, "evidence.txt")).resolves.toBe(await realpath(path.join(workspace, "evidence.txt")));
      // A directory junction needs no Windows symlink privilege.
      await symlink(root, path.join(workspace, "outside"), "junction");
      await expect(resolveResearchEvidencePath(workspace, "outside/outside.txt")).rejects.toThrow("outside its worker workspace");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
