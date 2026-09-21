import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundledGitExecutable, configureBundledGit } from "../bundled-git";
import { discoverGitCommands, parseGitVersionOutput, validateGitCommand } from "../settings/git-discovery";

afterEach(() => configureBundledGit());

describe("bundled Git discovery", () => {
  it("reports bundled Git and LFS despite legacy path overrides", async () => {
    const result = await discoverGitCommands({
      configuredCommand: "/missing/custom/git",
      env: { ...process.env, PWRAGENT_GIT_PATH: "/missing/env/git", LOCAL_GIT_DIRECTORY: "/missing/distribution", GIT_EXEC_PATH: "/missing/helpers" },
    });
    expect(result.selectedCommand).toBe(bundledGitExecutable());
    expect(result.candidates).toEqual([expect.objectContaining({
      source: "bundled", selected: true, executable: true,
      version: expect.stringMatching(/^\d+\./), lfsVersion: expect.stringMatching(/^\d+\./),
    })]);
  });

  it("reports a missing packaged runtime instead of discovering installed Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-missing-git-"));
    try {
      configureBundledGit(root);
      const result = await discoverGitCommands();
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ source: "bundled", executable: false });
      expect(result.selectedCommand).toContain(root);
    } finally {
      configureBundledGit();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects an installed runtime requested by an older settings client", async () => {
    await expect(validateGitCommand({ command: "/usr/bin/git" })).rejects.toThrow("bundled Git");
  });

  it("parses both upstream and Windows Git versions", () => {
    expect(parseGitVersionOutput("git version 2.53.0\n")).toBe("2.53.0");
    expect(parseGitVersionOutput("git version 2.53.0.windows.4\n")).toBe("2.53.0.windows.4");
  });
});
