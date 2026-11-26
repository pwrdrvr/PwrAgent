import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import * as gitExecutable from "../app-server/git-executable";
import { bundledGitDirectory, bundledGitExecutable, configureBundledGit } from "../bundled-git";
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

function missingCheckoutError(cwd: string): Error {
  return Object.assign(new Error("not found"), {
    code: 128,
    killed: false,
    stderr: `fatal: cannot change to '${cwd}': No such file or directory\n`,
  });
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

async function packagedGitFixture() {
  const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-packaged-selection-")));
  onTestFinished(async () => await rm(sandbox, { recursive: true, force: true }));
  onTestFinished(isolateProcessGitEnvironment());
  onTestFinished(() => { vi.unstubAllEnvs(); configureBundledGit(undefined); });
  for (const key of Object.keys(process.env)) {
    if (/^(?:DYLD_|LD_|GIT_TEST_|GIT_IMPLICIT_WORK_TREE$)/i.test(key)) vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", sandbox);
  vi.stubEnv("USERPROFILE", sandbox);
  vi.stubEnv("XDG_CONFIG_HOME", sandbox);
  configureBundledGit(path.dirname(bundledGitDirectory()));
  return { sandbox, executable: bundledGitExecutable() };
}

describe("StackReader installed-Git and unavailable checkout budgets", () => {
  it.skipIf(process.platform === "win32")("skips ordinary unrelated checkouts for explicitly selected packaged Git while matching the live Git projection", async () => {
    const { sandbox, executable } = await packagedGitFixture();
    const stacked = path.join(sandbox, "stacked");
    const unrelated = path.join(sandbox, "unrelated");
    const nested = path.join(unrelated, "nested");
    const missing = path.join(sandbox, "missing");
    for (const cwd of [stacked, unrelated]) {
      await mkdir(cwd);
      initialize(cwd);
    }
    await mkdir(nested);
    await writeCatalog(stacked, "stacked");
    const wrapper = path.join(sandbox, "git-wrapper");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(wrapper, `#!/bin/sh\nexec ${quote(executable)} "$@"\n`, { mode: 0o700 });
    const starts = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    onTestFinished(() => starts.mockRestore());
    const layer = { ...row(stacked, "stacked"), gitBranch: "feat" };
    const checkoutReads = () => starts.mock.calls.filter(([, [verb], purpose]) =>
      verb === "rev-parse" && purpose === "stack-checkout").map(([cwd]) => cwd);

    // Adding unrelated rows must preserve the Git-backed catalog and bindings.
    // Only the package's own entry point may prune their ordinary checkouts.
    await fc.assert(fc.asyncProperty(fc.shuffledSubarray([unrelated, nested], { minLength: 1 }), async (paths) => {
      const rows = [layer, row(missing, "missing"), ...paths.map((cwd) => row(cwd, cwd))];
      process.env.PWRAGENT_GIT_PATH = wrapper;
      const oracle = await new StackReader().read(rows, []);
      expect(oracle.stacks[0]?.layers[0]?.thread?.key).toContain("stacked");
      starts.mockClear();
      process.env.PWRAGENT_GIT_PATH = executable;
      const actual = await new StackReader().read(rows, []);
      expect(actual).toEqual(oracle);
      expect(checkoutReads()).toContain(stacked);
      expect(checkoutReads()).toContain(missing);
      expect(checkoutReads().filter((cwd) => paths.includes(cwd))).toEqual([]);
    }), { numRuns: 3, examples: [[[unrelated, nested]]] });

    // A wrapper can discover the stack from a path with no catalog of its own.
    await writeFile(wrapper, [
      "#!/bin/sh",
      `if [ "$1" = "-C" ] && [ "$2" = ${quote(unrelated)} ]; then shift 2; set -- -C ${quote(stacked)} "$@"; fi`,
      `exec ${quote(executable)} "$@"`,
      "",
    ].join("\n"));
    process.env.PWRAGENT_GIT_PATH = wrapper;
    starts.mockClear();
    const redirectedRow: NavigationThreadSummary = { ...row(unrelated, "redirected"), gitBranch: "feat" };
    const redirected = await new StackReader().read([redirectedRow], []);
    expect(redirected.stacks[0]?.layers[0]?.thread?.key).toContain("redirected");
    expect(redirected.stacks[0]?.repository).toBe("github.com:fixture/stacked");
    expect(checkoutReads()).toContain(unrelated);

    process.env.PWRAGENT_GIT_PATH = executable;
    vi.stubEnv("GIT_COMMON_DIR", path.join(stacked, ".git"));
    starts.mockClear();
    const overridden = await new StackReader().read([redirectedRow], []);
    expect(overridden.stacks[0]?.repository).toBe("github.com:fixture/stacked");
    expect(checkoutReads()).toContain(unrelated);
    vi.stubEnv("GIT_COMMON_DIR", undefined);

    const withAttachment: NavigationThreadSummary = { ...layer, prs: [{
      number: 1, provider: "github.com", org: "fixture", repo: "stacked", state: "passing",
      lifecycleState: "open", url: "https://github.com/fixture/stacked/pull/1", explicitlyAttached: true,
      headRefName: "feat", linkedDirectoryPaths: [stacked],
    }] };
    const rows = [withAttachment, redirectedRow];
    const validate = async (candidate: Pick<NavigationThreadSummary, "prs">) => candidate.prs ?? [];
    process.env.PWRAGENT_GIT_PATH = wrapper;
    const oracle = await new StackReader().read(rows, [], undefined, undefined, undefined, validate);
    starts.mockClear();
    process.env.PWRAGENT_GIT_PATH = executable;
    const afterSelectionChange = await new StackReader().read(rows, [], undefined, undefined, undefined, async (candidate) => {
      process.env.PWRAGENT_GIT_PATH = wrapper;
      return await validate(candidate);
    });
    expect(afterSelectionChange).toEqual(oracle);
    expect(checkoutReads()).toContain(unrelated);

    process.env.PWRAGENT_GIT_PATH = executable;
    const reader = new StackReader();
    const unrelatedRows = [{ ...row(unrelated, "new-stack"), gitBranch: "feat" }];
    expect((await reader.read(unrelatedRows, [])).stacks).toEqual([]);
    await writeCatalog(unrelated, "unrelated");
    expect((await reader.read(unrelatedRows, [])).stacks[0]?.repository).toBe("github.com:fixture/unrelated");
  });

  it.skipIf(process.platform === "win32")("admits a nested inferred stack only in the clone found by Git", async () => {
    const { sandbox, executable } = await packagedGitFixture();
    const outer = path.join(sandbox, "outer");
    const inner = path.join(outer, "inner");
    await mkdir(inner, { recursive: true });
    initialize(outer);
    initialize(inner);
    git(inner, "branch", "lower");
    git(inner, "branch", "upper");
    const thread = (cwd: string, id: string, repo: string, number: number, head: string, base: string) => {
      const pr: PrSummary = {
        number, provider: "github.com", org: "fixture", repo, lifecycleState: "open", state: "passing",
        headRefName: head, baseRefName: base, url: `https://github.com/fixture/${repo}/pull/${number}`,
        linkedDirectoryPaths: [cwd],
      };
      return { ...row(cwd, id), prs: [pr] };
    };
    const rows = [
      thread(inner, "lower", "inner", 1, "lower", "main"),
      thread(inner, "upper", "inner", 2, "upper", "lower"),
      thread(outer, "outer", "outer", 3, "outer-topic", "main"),
    ];
    const wrapper = path.join(sandbox, "git-wrapper");
    const quoted = "'" + executable.replaceAll("'", "'\\''") + "'";
    await writeFile(wrapper, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o700 });
    const read = async (command: string) => {
      process.env.PWRAGENT_GIT_PATH = command;
      const validated: string[] = [];
      const projection = await new StackReader().read(rows, [], undefined, undefined, undefined, async (candidate) => {
        validated.push(candidate.id);
        return candidate.prs;
      });
      return { ...projection, validated: validated.sort() };
    };

    // Git resolves the nested repository's PR chain to one clone. The
    // enclosing repository has an attachment but no stack of its own.
    const live = await read(wrapper);
    expect(live.stacks).toHaveLength(1);
    expect(live.stacks[0]).toMatchObject({ repository: "github.com:fixture/inner", inferred: true });
    expect(live.catalogs).toEqual([{ status: "missing" }]);
    expect(live.validated).toEqual(["lower", "upper"]);
    const starts = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    onTestFinished(() => starts.mockRestore());
    expect(await read(executable)).toEqual(live);
    expect(starts.mock.calls.filter(([, [verb], purpose]) => verb === "rev-parse" && purpose === "stack-checkout")
      .map(([cwd]) => cwd)).toEqual([inner]);
  });

  it("revalidates attachment checkouts without repeating Git on unrelated repositories", async () => {
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-witnesses-")));
    restoreGit = isolateProcessGitEnvironment(sandbox);
    const starts = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      const stacked = path.join(sandbox, "stacked");
      const secondary = path.join(sandbox, "secondary");
      const unrelated = path.join(sandbox, "unrelated");
      for (const cwd of [stacked, secondary, unrelated]) {
        await mkdir(cwd);
        initialize(cwd);
      }
      await writeCatalog(stacked, "stacked");
      await writeCatalog(unrelated, "unrelated");
      const layer = row(stacked, "layer");
      layer.linkedDirectories.push(row(secondary, "other-link").linkedDirectories[0]!);
      layer.prs = [{ number: 1, provider: "github.com", org: "fixture", repo: "stacked", state: "passing",
        lifecycleState: "open", url: "https://github.com/fixture/stacked/pull/1", explicitlyAttached: true,
        headRefName: "feat", linkedDirectoryPaths: [stacked] }];
      layer.prs.push({ ...layer.prs[0]!, number: 2, url: "https://github.com/fixture/stacked/pull/2", linkedDirectoryPaths: undefined });
      // Explicit Git with config overrides supplies the checkout oracle. There
      // are no filesystem witnesses to substitute for its live observations.
      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      const validate = async (candidate: Pick<NavigationThreadSummary, "prs">) => candidate.prs ?? [];
      const oracle = await new StackReader().read([layer], [], undefined, undefined, undefined, validate);
      const other = row(unrelated, "unrelated");
      const independent = await new StackReader().read([other], []);
      starts.mockClear();
      const actual = await new StackReader().read([layer, other], [], undefined, undefined, undefined, validate);
      expect(actual.stacks).toEqual([...oracle.stacks, ...independent.stacks]);
      expect(actual.catalogs).toEqual([...oracle.catalogs, ...independent.catalogs]);
      expect(actual.stacks[0]?.layers[0]?.pullRequest?.number).toBe(1);
      const checkoutReads = (cwd: string) => starts.mock.calls.filter(([directory, [verb], purpose]) =>
        directory === cwd && verb === "rev-parse" && purpose === "stack-checkout").length;
      expect(checkoutReads(stacked)).toBeGreaterThan(1);
      expect(checkoutReads(secondary)).toBeGreaterThan(1);
      expect(checkoutReads(unrelated)).toBe(1);
    } finally {
      starts.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

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
    const realRunGit = gitExecutable.runGitCommand;
    const runSpy = vi.spyOn(gitExecutable, "runGitCommand");
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
      const fixturePaths = new Set(rows.map((item) => item.linkedDirectories[0]!.path));
      const observed = new Map<string, ReturnType<typeof realRunGit>>();
      // Sample the real checkout once. The generated cases vary only the
      // clock and revalidation budget, so they need the same Git answers.
      runSpy.mockImplementation((cwd, args, options) => {
        const answer = realRunGit(cwd, args, options);
        if (cwd === tracked) observed.set(JSON.stringify(args), answer);
        return answer;
      });
      const oracle = await new StackReader().read([rows[0]!], []);
      start.mockClear();
      runSpy.mockImplementation(async (cwd, args, options) => {
        const answer = cwd === tracked ? observed.get(JSON.stringify(args)) : undefined;
        if (answer) return await answer;
        if (cwd !== tracked && fixturePaths.has(cwd) && args[0] === "rev-parse") throw missingCheckoutError(cwd);
        return await realRunGit(cwd, args, options);
      });
      const probedPaths = () => runSpy.mock.calls
        .filter(([cwd, args]) => fixturePaths.has(cwd) && args[0] === "rev-parse").map(([cwd]) => cwd);

      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.constantFrom(0, 15_000, 30_000, 31_000, 62_000), { minLength: 4, maxLength: 4 }),
        async (budget, extra, gaps) => {
          const subsetSize = Math.min(maxDirs, budget + extra);
          const subset = rows.slice(0, subsetSize);
          let now = 0;
          const reader = new StackReader(() => now, budget);

          runSpy.mockClear();
          const cold = await reader.read(subset, []);
          expect(cold.stacks).toEqual(oracle.stacks);
          expect(probedPaths()).toHaveLength(subsetSize);

          now += 31_000;
          const refreshedPaths = new Set<string>();
          for (let pass = 0; pass < Math.ceil(subsetSize / budget); pass++) {
            runSpy.mockClear();
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
      expect(start.mock.calls.filter(([cwd]) => fixturePaths.has(cwd))).toEqual([]);
    } finally {
      runSpy.mockRestore();
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
      const fixturePaths = new Set(dirs);
      const rows = dirs.map((dir, index) => row(dir, `deleted-${index}`));
      const preflight = dirs[0]!;
      let initialized = false;
      const runSpy = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (args[0] === "rev-parse" && fixturePaths.has(cwd) && !(initialized && cwd === preflight)) {
          throw missingCheckoutError(cwd);
        }
        return await realRunGit(cwd, args, options);
      });
      try {
        let now = 0;
        const reader = new StackReader(() => now);
        const revParseCalls = () => runSpy.mock.calls
          .filter(([cwd, args]) => fixturePaths.has(cwd) && args[0] === "rev-parse").length;

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
