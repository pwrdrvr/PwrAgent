import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundledGitExecutable, configureBundledGit } from "../bundled-git";
import { discoverGitCommands, parseGitVersionOutput, validateGitCommand } from "../settings/git-discovery";

afterEach(() => configureBundledGit());

describe("Git discovery", () => {
  it("selects bundled Git and LFS by default while retaining installed candidates", async () => {
    const result = await discoverGitCommands({ env: { ...process.env, PWRAGENT_GIT_PATH: undefined } });
    expect(result.selectedCommand).toBe(bundledGitExecutable());
    expect(result.candidates).toContainEqual(expect.objectContaining({
      source: "bundled", selected: true, executable: true,
      version: expect.stringMatching(/^\d+\./), lfsVersion: expect.stringMatching(/^\d+\./),
    }));
  });

  it("keeps a broken env override selected ahead of config and the working bundle", async () => {
    const result = await discoverGitCommands({ configuredCommand: "/missing/config/git", env: { ...process.env, PWRAGENT_GIT_PATH: "/missing/env/git" } });
    expect(result.selectedCommand).toBe("/missing/env/git");
    expect(result.candidates.find((candidate) => candidate.selected)).toMatchObject({ source: "env", executable: false });
    expect(result.candidates.find((candidate) => candidate.source === "bundled")).toMatchObject({ selected: false, executable: true });
  });

  it("keeps a broken configured override selected without fallback", async () => {
    const result = await discoverGitCommands({ configuredCommand: "/missing/config/git", env: { ...process.env, PWRAGENT_GIT_PATH: undefined } });
    expect(result.selectedCommand).toBe("/missing/config/git");
    expect(result.candidates.find((candidate) => candidate.selected)).toMatchObject({
      source: "config",
      executable: false,
    });
  });

  it("keeps a configured well-known path under the source that found it", async () => {
    // Settings titles each row by its source, so a configured Homebrew git
    // reading "Custom path" would hide where it came from.
    const result = await discoverGitCommands({
      configuredCommand: bundledGitExecutable(),
      env: { ...process.env, PWRAGENT_GIT_PATH: undefined },
    });
    expect(result.selectedSource).toBe("bundled");
    expect(result.candidates.filter((candidate) => candidate.command === bundledGitExecutable()))
      .toEqual([expect.objectContaining({ source: "bundled", selected: true })]);
    expect(result.candidates.some((candidate) => candidate.source === "config")).toBe(false);
  });

  it("reports a missing packaged runtime without selecting an installed Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-missing-git-"));
    try {
      configureBundledGit(root);
      const result = await discoverGitCommands({ env: { ...process.env, PWRAGENT_GIT_PATH: undefined } });
      expect(result.candidates.find((candidate) => candidate.selected)).toMatchObject({ source: "bundled", executable: false });
      expect(result.selectedCommand).toContain(root);
    } finally {
      configureBundledGit();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("validates Git and LFS for a manually selected executable", async () => {
    expect(await validateGitCommand({ command: bundledGitExecutable() })).toMatchObject({
      executable: true, version: expect.any(String), lfsVersion: expect.any(String),
    });
    expect(await validateGitCommand({ command: "/missing/manual/git" })).toMatchObject({ executable: false });
  });

  it("parses both upstream and Windows Git versions", () => {
    expect(parseGitVersionOutput("git version 2.53.0\n")).toBe("2.53.0");
    expect(parseGitVersionOutput("git version 2.53.0.windows.4\n")).toBe("2.53.0.windows.4");
  });
});
