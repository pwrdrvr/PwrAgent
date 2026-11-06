import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundledGitExecutable, bundledGitLfsExecutable, configureBundledGit } from "../bundled-git";
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

  it("selects the row a configured bare command resolves to", async () => {
    // Discovery resolves `git` against PATH, so the selection has to match
    // the resolved row; otherwise Settings reports no Git while spawns use it.
    const result = await discoverGitCommands({
      configuredCommand: "git",
      env: { ...process.env, PWRAGENT_GIT_PATH: undefined },
    });
    expect(result.candidates.filter((candidate) => candidate.selected)).toHaveLength(1);
    expect(result.selectedCommand).toBe(
      result.candidates.find((candidate) => candidate.selected)?.command,
    );
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
    // A selected Git finds git-lfs on PATH, never inside PwrAgent's bundle, so
    // supply one rather than depend on whatever the machine has installed.
    const lfsRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-manual-lfs-"));
    try {
      const lfs = path.join(lfsRoot, path.basename(bundledGitLfsExecutable()));
      if (process.platform === "win32") await copyFile(bundledGitLfsExecutable(), lfs);
      else await symlink(bundledGitLfsExecutable(), lfs);
      // Replace the key the host uses: Windows spells it `Path`.
      const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      const env = { ...process.env, [pathKey]: [lfsRoot, process.env[pathKey]].join(path.delimiter) };
      expect(await validateGitCommand({ command: bundledGitExecutable(), env })).toMatchObject({
        executable: true, version: expect.any(String), lfsVersion: expect.any(String),
      });
      expect(await validateGitCommand({ command: "/missing/manual/git", env })).toMatchObject({ executable: false });
    } finally {
      await rm(lfsRoot, { force: true, recursive: true });
    }
  });

  describe("downloaded PwrDrvr Git releases", () => {
    const noEnv = { ...process.env, PWRAGENT_GIT_PATH: undefined };
    const rejected = (generation: string) => ({
      generation,
      executable: `/releases/${generation}/bin/git`,
      root: `/releases/${generation}`,
      failure: "A file changed after the release was sealed: bin/git",
    });

    it("asks for the release list at once and lists releases just above the bundle", async () => {
      let loaded!: (list: ReturnType<typeof rejected>[]) => void;
      let loaderCalled = false;
      const pending = discoverGitCommands({
        env: noEnv,
        managed: () => {
          loaderCalled = true;
          return new Promise((resolve) => { loaded = resolve; });
        },
      });
      expect(loaderCalled).toBe(true);
      loaded([rejected("2.56.0-dev-pwrgit.6-bbbbbbb"), rejected("2.56.0-dev-pwrgit.5-aaaaaaa")]);
      const result = await pending;
      const sources = result.candidates.map((candidate) => candidate.generation ?? candidate.source);
      const bundledAt = sources.indexOf("bundled");
      expect(sources.slice(bundledAt - 2, bundledAt + 1))
        .toEqual(["2.56.0-dev-pwrgit.6-bbbbbbb", "2.56.0-dev-pwrgit.5-aaaaaaa", "bundled"]);
      expect(result.selectedSource).toBe("bundled");
    });

    it("keeps a chosen release selected when it fails a check or is gone, never the bundle", async () => {
      for (const managed of [[rejected("2.56.0-dev-pwrgit.5-aaaaaaa")], []]) {
        const result = await discoverGitCommands({
          env: noEnv,
          managed: async () => managed,
          selectedManaged: "2.56.0-dev-pwrgit.5-aaaaaaa",
        });
        expect(result.candidates.filter((candidate) => candidate.selected)).toEqual([
          expect.objectContaining({
            source: "managed",
            generation: "2.56.0-dev-pwrgit.5-aaaaaaa",
            executable: false,
            failureReason: expect.stringMatching(/sealed|no longer installed/),
          }),
        ]);
      }
    });

    it("lets a manual path win over a chosen release, and shows no row for a missing one", async () => {
      const result = await discoverGitCommands({
        configuredCommand: "/missing/config/git",
        env: noEnv,
        managed: async () => [],
        selectedManaged: "2.56.0-dev-pwrgit.5-aaaaaaa",
      });
      expect(result.selectedSource).toBe("config");
      expect(result.candidates.some((candidate) => candidate.source === "managed")).toBe(false);
    });

    it("treats a failed release list as no releases", async () => {
      const result = await discoverGitCommands({ env: noEnv, managed: async () => { throw new Error("EACCES"); } });
      expect(result.candidates.some((candidate) => candidate.source === "managed")).toBe(false);
      expect(result.selectedSource).toBe("bundled");
    });
  });

  it("parses both upstream and Windows Git versions", () => {
    expect(parseGitVersionOutput("git version 2.53.0\n")).toBe("2.53.0");
    expect(parseGitVersionOutput("git version 2.53.0.windows.4\n")).toBe("2.53.0.windows.4");
  });
});
