import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import * as gitExecutable from "../app-server/git-executable";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { StackReader } from "../stacks/stack-reader";
import { isolateProcessGitEnvironment, runIsolatedGitSync } from "./helpers/isolated-git";

let restoreGit: (() => void) | undefined;

afterEach(() => {
  restoreGit?.();
  restoreGit = undefined;
});

function git(cwd: string, ...args: string[]): string {
  return runIsolatedGitSync(cwd, args).trim();
}

function initialize(cwd: string): string {
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", "trunk");
  return git(cwd, "rev-parse", "HEAD");
}

async function writeCatalog(cwd: string, name: string): Promise<void> {
  const trunk = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-q", "-b", "feat");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", "feat");
  const head = git(cwd, "rev-parse", "HEAD");
  await writeFile(path.join(cwd, ".git", "gh-stack"), JSON.stringify({
    schemaVersion: 1,
    repository: `github.com:fixture/${name}`,
    stacks: [{
      trunk: { branch: "main", head: trunk },
      branches: [{ branch: "feat", head, base: trunk }],
    }],
  }));
}

function row(cwd: string, id: string): NavigationThreadSummary {
  return {
    id,
    source: "codex",
    title: id,
    titleSource: "explicit",
    gitBranch: "main",
    inbox: { inInbox: false },
    linkedDirectories: [{ id: cwd, path: cwd, kind: "local", label: id }],
  };
}

describe("StackReader installed-Git and unavailable checkout budgets", () => {
  it("caches broken .git pointers for background reads while keeping scoped reads live and honoring disk repair", async () => {
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-broken-git-")));
    restoreGit = isolateProcessGitEnvironment();
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      const brokenCount = 3;
      const brokenDirs: string[] = [];
      for (let index = 0; index < brokenCount; index++) {
        const dir = path.join(sandbox, `broken-${index}`);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, ".git"), `gitdir: ${path.join(sandbox, `missing-target-${index}`)}\n`);
        brokenDirs.push(dir);
      }
      const validDir = path.join(sandbox, "valid");
      await mkdir(validDir, { recursive: true });
      initialize(validDir);
      await writeCatalog(validDir, "valid");

      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      const now = 0;
      const reader = new StackReader(() => now);
      const rows = [row(validDir, "valid"), ...brokenDirs.map((dir, index) => row(dir, `broken-${index}`))];
      const revParseCalls = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse").length;

      // Cold background pass probes every directory once.
      const first = await reader.read(rows, []);
      expect(first.stacks).toHaveLength(1);
      expect(revParseCalls()).toBe(1 + brokenCount);

      // Repeated background reads while disk is unchanged must not re-spawn
      // failing rev-parse calls for the broken .git pointers.
      start.mockClear();
      for (let pass = 0; pass < 3; pass++) {
        const repeat = await reader.read(rows, []);
        expect(repeat.stacks).toHaveLength(1);
      }
      expect(revParseCalls()).toBe(0);

      // Scoped reads remain live and must still probe the explicit broken anchor.
      start.mockClear();
      const scoped = await reader.read(rows, [], [brokenDirs[0]!]);
      expect(scoped.catalogs).toEqual([{ status: "unavailable" }]);
      expect(revParseCalls()).toBe(1);

      // Replacing a broken .git pointer with a real stacked repo invalidates
      // the negative cache immediately on the next background read.
      await rm(path.join(brokenDirs[0]!, ".git"));
      initialize(brokenDirs[0]!);
      await writeCatalog(brokenDirs[0]!, "repaired");
      start.mockClear();
      const repaired = await reader.read(rows, []);
      expect(repaired.stacks).toHaveLength(2);
      expect(revParseCalls()).toBe(1);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("bounds synchronous TTL revalidation to the default 16-entry budget when many installed-Git checkouts expire together", async () => {
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-ttl-default-")));
    restoreGit = isolateProcessGitEnvironment();
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      const tracked = path.join(sandbox, "tracked");
      await mkdir(tracked, { recursive: true });
      initialize(tracked);
      await writeCatalog(tracked, "tracked");

      const totalDirs = 18;
      const rows = [
        row(tracked, "tracked"),
        ...Array.from({ length: totalDirs - 1 }, (_, index) => row(path.join(sandbox, `missing-${index}`), `missing-${index}`)),
      ];

      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      const revParseCalls = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse").length;
      const oracle = await new StackReader().read([rows[0]!], []);

      let now = 0;
      const reader = new StackReader(() => now);
      start.mockClear();
      const cold = await reader.read(rows, []);
      expect(cold.stacks).toEqual(oracle.stacks);
      expect(revParseCalls()).toBe(totalDirs);

      // Expire all cached entries at once: one background pass must cap
      // synchronous TTL revalidations at the default budget (16).
      now += 31_000;
      start.mockClear();
      const firstRefresh = await reader.read(rows, []);
      expect(firstRefresh.stacks).toEqual(oracle.stacks);
      const firstPassSpawns = revParseCalls();
      expect(firstPassSpawns).toBe(16);

      // A second pass rotates through the remaining expired entries, and once
      // all entries are refreshed, a third pass spawns zero rev-parse calls.
      start.mockClear();
      const secondRefresh = await reader.read(rows, []);
      expect(secondRefresh.stacks).toEqual(oracle.stacks);
      expect(revParseCalls()).toBe(totalDirs - firstPassSpawns);

      start.mockClear();
      const warm = await reader.read(rows, []);
      expect(warm.stacks).toEqual(oracle.stacks);
      expect(revParseCalls()).toBe(0);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("rotates expired installed-Git TTL revalidations across passes for any configured budget", async () => {
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-ttl-budget-")));
    restoreGit = isolateProcessGitEnvironment();
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      const tracked = path.join(sandbox, "tracked");
      await mkdir(tracked, { recursive: true });
      initialize(tracked);
      await writeCatalog(tracked, "tracked");

      const maxDirs = 8;
      const rows = [
        row(tracked, "tracked"),
        ...Array.from({ length: maxDirs - 1 }, (_, index) => row(path.join(sandbox, `missing-${index}`), `missing-${index}`)),
      ];

      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      const revParseCalls = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse").length;
      const oracle = await new StackReader().read([rows[0]!], []);

      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        async (budget, extra) => {
          const subsetSize = Math.min(maxDirs, budget + extra);
          const subset = rows.slice(0, subsetSize);
          let now = 0;
          const reader = new StackReader(() => now, budget);

          start.mockClear();
          const cold = await reader.read(subset, []);
          expect(cold.stacks).toEqual(oracle.stacks);
          expect(revParseCalls()).toBe(subsetSize);

          now += 31_000;
          let remaining = subsetSize;
          while (remaining > 0) {
            start.mockClear();
            const refreshed = await reader.read(subset, []);
            expect(refreshed.stacks).toEqual(oracle.stacks);
            const expectedSpawns = Math.min(remaining, budget);
            expect(revParseCalls()).toBe(expectedSpawns);
            remaining -= expectedSpawns;
          }

          start.mockClear();
          const warm = await reader.read(subset, []);
          expect(warm.stacks).toEqual(oracle.stacks);
          expect(revParseCalls()).toBe(0);
        },
      ), { numRuns: 4 });
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
