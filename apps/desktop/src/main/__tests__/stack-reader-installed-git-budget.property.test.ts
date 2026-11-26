import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import * as gitExecutable from "../app-server/git-executable";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { StackReader, StackReadObservation } from "../stacks/stack-reader";
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
  it("drops an alias-backed attachment when selected Git rejects changed global config", async () => {
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-installed-alias-")));
    restoreGit = isolateProcessGitEnvironment();
    try {
      const checkout = path.join(sandbox, "checkout");
      const alias = path.join(sandbox, "alias");
      const home = path.join(sandbox, "home");
      const config = path.join(home, ".gitconfig");
      await Promise.all([mkdir(checkout), mkdir(home)]);
      initialize(checkout);
      await writeCatalog(checkout, "tracked");
      await symlink(checkout, alias, "junction");
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.stubEnv("XDG_CONFIG_HOME", home);
      await writeFile(config, "[user]\n\tname = Fixture\n");
      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      const rows: NavigationThreadSummary[] = [{ ...row(checkout, "tracked"), prs: [{
        number: 1, provider: "github.com", org: "fixture", repo: "tracked", lifecycleState: "open", state: "passing",
        url: "https://github.com/fixture/tracked/pull/1", headRefName: "feat", linkedDirectoryPaths: [alias],
        explicitlyAttached: true,
      }] }];
      const reader = new StackReader(() => 0);
      const layer = async () => (await reader.read(rows, [])).stacks[0]?.layers[0];
      expect((await layer())?.pullRequest?.number).toBe(1);

      await writeFile(config, "[invalid config\n");
      await expect(gitExecutable.runGitCommand(alias, ["rev-parse", "--show-toplevel"])).rejects.toMatchObject({ code: 128 });
      // The catalog can still show the layer, but Git no longer corroborates its attachment.
      const invalid = await layer();
      expect(invalid).toMatchObject({ branch: "feat" });
      expect(invalid?.pullRequest).toBeUndefined();

      await writeFile(config, "[user]\n\tname = Fixture\n");
      expect((await layer())?.pullRequest?.number).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

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
      const probedPaths = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse").map(([cwd]) => cwd);
      const oracle = await new StackReader().read([rows[0]!], []);

      let now = 0;
      const reader = new StackReader(() => now);
      start.mockClear();
      const cold = await reader.read(rows, []);
      expect(cold.stacks).toEqual(oracle.stacks);
      expect(probedPaths()).toHaveLength(totalDirs);

      // Expire all cached entries at once: one background pass must cap
      // synchronous TTL revalidations at the default budget (16).
      now += 31_000;
      start.mockClear();
      const firstRefresh = await reader.read(rows, []);
      expect(firstRefresh.stacks).toEqual(oracle.stacks);
      const firstPass = probedPaths();
      expect(firstPass).toHaveLength(16);

      // Another long gap expires even the just-refreshed entries. The last
      // two must still get slots on the second pass.
      now += 31_000;
      start.mockClear();
      const secondRefresh = await reader.read(rows, []);
      expect(secondRefresh.stacks).toEqual(oracle.stacks);
      const secondPass = probedPaths();
      expect(secondPass).toHaveLength(16);
      expect(new Set([...firstPass, ...secondPass])).toEqual(new Set(rows.map((item) => item.linkedDirectories[0]!.path)));
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
      const probedPaths = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse").map(([cwd]) => cwd);
      const oracle = await new StackReader().read([rows[0]!], []);

      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.constantFrom(0, 15_000, 30_000, 31_000, 62_000), { minLength: 4, maxLength: 4 }),
        async (budget, extra, gaps) => {
          const subsetSize = Math.min(maxDirs, budget + extra);
          const subset = rows.slice(0, subsetSize);
          let now = 0;
          const reader = new StackReader(() => now, budget);

          start.mockClear();
          const cold = await reader.read(subset, []);
          expect(cold.stacks).toEqual(oracle.stacks);
          expect(probedPaths()).toHaveLength(subsetSize);

          now += 31_000;
          const refreshedPaths = new Set<string>();
          for (let pass = 0; pass < Math.ceil(subsetSize / budget); pass++) {
            start.mockClear();
            const refreshed = await reader.read(subset, []);
            expect(refreshed.stacks).toEqual(oracle.stacks);
            const paths = probedPaths();
            expect(paths.length).toBeLessThanOrEqual(budget);
            for (const cwd of paths) refreshedPaths.add(cwd);
            now += gaps[pass] ?? 31_000;
          }
          expect(refreshedPaths).toEqual(new Set(subset.map((item) => item.linkedDirectories[0]!.path)));
        },
      ), { numRuns: 4 });
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("caches unavailable installed-Git lookup results for hinted directories without enclosing markers", async () => {
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-hinted-unavail-")));
    restoreGit = isolateProcessGitEnvironment();
    const realRunGit = gitExecutable.runGitCommand;
    try {
      const plain = path.join(sandbox, "plain");
      await mkdir(plain, { recursive: true });
      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      // Simulate a transient non-128 failure from the configured Git executable
      // on a directory where filesystem hints found no enclosing .git markers.
      const runSpy = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (cwd === plain && args[0] === "rev-parse") {
          throw Object.assign(new Error("transient git failure"), { code: 1, killed: false, stderr: "transient" });
        }
        return await realRunGit(cwd, args, options);
      });
      try {
        const now = 0;
        const reader = new StackReader(() => now);
        const rows = [row(plain, "plain")];
        const revParseCalls = () => runSpy.mock.calls.filter(([cwd, args]) => cwd === plain && args[0] === "rev-parse").length;

        await reader.read(rows, []);
        expect(revParseCalls()).toBe(1);

        // Repeat within the 30s unavailable TTL: must hit cache instead of
        // re-spawning rev-parse on every background navigation pass.
        runSpy.mockClear();
        for (let pass = 0; pass < 3; pass++) {
          await reader.read(rows, []);
        }
        expect(revParseCalls()).toBe(0);
      } finally {
        runSpy.mockRestore();
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("retains active installed-Git checkouts across repeated passes when directory count exceeds the 2,048 base cap", async () => {
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-large-cap-")));
    restoreGit = isolateProcessGitEnvironment();
    const realRunGit = gitExecutable.runGitCommand;
    try {
      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      // 2,060 distinct missing directories crosses the historic 2,048 FIFO cap
      // while avoiding real git subprocesses via a fast mocked exit-128 oracle.
      const count = 2_060;
      const dirs = Array.from({ length: count }, (_, index) =>
        path.join(sandbox, `deleted-${String(index).padStart(4, "0")}`));
      const rows = dirs.map((dir, index) => row(dir, `deleted-${index}`));
      const preflight = dirs[0]!;
      let initialized = false;
      const runSpy = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (args[0] === "rev-parse" && cwd.startsWith(sandbox) && !(initialized && cwd === preflight)) {
          throw Object.assign(new Error("not found"), {
            code: 128,
            killed: false,
            stderr: `fatal: cannot change to '${cwd}': No such file or directory\n`,
          });
        }
        return await realRunGit(cwd, args, options);
      });
      try {
        let now = 0;
        const reader = new StackReader(() => now);
        const revParseCalls = () => runSpy.mock.calls.filter(([, args]) => args[0] === "rev-parse").length;

        await reader.read(rows, []);
        expect(revParseCalls()).toBe(count);

        // Warm repeat within TTL must keep 100% of the active inventory cached
        // (0 rev-parse spawns), never thrashing FIFO eviction back to 0% hits.
        runSpy.mockClear();
        await reader.read(rows, []);
        expect(revParseCalls()).toBe(0);

        // A checkout appeared since the inventory scan. Its narrow preflight
        // replaces the cached miss without evicting other fresh checkouts.
        await mkdir(preflight);
        initialize(preflight);
        initialized = true;
        await reader.preflightCatalogs([preflight], new StackReadObservation());
        expect(revParseCalls()).toBe(1);
        runSpy.mockClear();
        await reader.read(rows, []);
        expect(revParseCalls()).toBe(0);

        // After TTL expiry, synchronous revalidation stays capped at 16/pass.
        now += 31_000;
        runSpy.mockClear();
        await reader.read(rows, []);
        expect(revParseCalls()).toBe(16);
      } finally {
        runSpy.mockRestore();
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
