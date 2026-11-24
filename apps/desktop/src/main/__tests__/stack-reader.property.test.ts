import { cp, lstat, open, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as gitExecutable from "../app-server/git-executable";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { PR_METADATA_PRIORITY, runPrMetadataProcess } from "../pr-status/pr-metadata-process";
import { StackOperationsService } from "../stacks/stack-operations-service";
import { StackReader, StackReadObservation, readGhStackCatalog, readStackClones } from "../stacks/stack-reader";
import { isolateProcessGitEnvironment, runIsolatedGitSync } from "./helpers/isolated-git";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, lstat: vi.fn(fs.lstat), open: vi.fn(fs.open) };
});

beforeEach(() => onTestFinished(isolateProcessGitEnvironment()));

function row(cwd: string, id: string) {
  return {
    id, source: "codex" as const, title: id,
    linkedDirectories: [{ id: cwd, label: id, kind: "local" as const, path: cwd }],
  };
}

const git = (cwd: string, ...args: string[]) => runIsolatedGitSync(cwd, args).trim();

function initialize(cwd: string) {
  git(cwd, "init", "-b", "topic");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "topic");
}

async function writeCatalog(cwd: string, name: string) {
  const head = git(cwd, "rev-parse", "HEAD");
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  await writeFile(path.join(common, "gh-stack"), JSON.stringify({
    schemaVersion: 1, repository: `github.com:fixture/${name}`,
    stacks: [{ trunk: { branch: "main", head }, branches: [{ branch: "topic", head, base: head }] }],
  }));
}

describe("stack checkout demand", () => {
  it("reuses Git's registered worktree inventory for ordinary sibling checkouts", async () => {
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-worktree-inventory-")));
    const primary = path.join(sandbox, "primary");
    try {
      await mkdir(primary);
      initialize(primary);
      git(primary, "branch", "main");
      await writeCatalog(primary, "registered");
      const worktrees = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
        const branch = `sibling-${index}`;
        const cwd = path.join(sandbox, branch);
        git(primary, "worktree", "add", "-b", branch, cwd);
        const [root, common] = git(cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir").split("\n");
        expect(await realpath(root!)).toBe(cwd);
        expect(await realpath(common!)).toBe(path.join(primary, ".git"));
        return row(cwd, branch);
      }));
      const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
      try {
        await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 4, maxLength: 7 }),
          async (indices) => {
            start.mockClear();
            const result = await new StackReader().read([row(primary, "tracked"), ...indices.map((index) => worktrees[index]!)], []);
            expect(result.stacks[0]?.layers[0]?.thread?.key).toBe("codex:tracked");
            // Once Git has verified a checkout in this clone, its live roster
            // can corroborate each standard linked checkout's disk identity.
            expect(start.mock.calls.filter(([, args, purpose]) => args[0] === "rev-parse" && purpose === "stack-checkout").length)
              .toBeLessThanOrEqual(2);
          }), { numRuns: 6 });
      } finally {
        start.mockRestore();
      }
      const reader = new StackReader();
      const inventory = [row(primary, "tracked"), ...worktrees];
      const read = async () => (await reader.read(inventory, [])).stacks[0]?.layers[0]?.thread?.key;
      expect(await read()).toBe("codex:tracked");
      git(primary, "checkout", "main");
      const sibling = worktrees[0]!.linkedDirectories[0]!.path;
      git(sibling, "checkout", "topic");
      expect(git(sibling, "symbolic-ref", "--short", "HEAD")).toBe("topic");
      expect(await read()).toBe("codex:sibling-0");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("refreshes a scoped catalog changed during sibling checkout discovery", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-catalog-during-discovery-"));
    const primary = path.join(sandbox, "primary");
    const sibling = path.join(sandbox, "sibling");
    try {
      await mkdir(primary);
      initialize(primary);
      git(primary, "branch", "main");
      git(primary, "worktree", "add", "-b", "lower", sibling);
      const head = git(primary, "rev-parse", "HEAD");
      const upper = { branch: "topic", head, base: head, pullRequest: { number: 2 } };
      const lower = { ...upper, branch: "lower", pullRequest: { number: 1 } };
      const catalog = path.join(primary, ".git", "gh-stack");
      const write = (...branches: (typeof upper)[]) => writeFile(catalog, JSON.stringify({
        schemaVersion: 1, repository: "github.com:fixture/stack",
        stacks: [{ trunk: { branch: "main", head }, branches }],
      }));
      await write(upper);
      const runGitCommand = gitExecutable.runGitCommand;
      let changed = false;
      const run = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (!changed && cwd === sibling && args[0] === "rev-parse") {
          await write(lower, upper);
          changed = true;
        }
        return await runGitCommand(cwd, args, options);
      });
      try {
        const { stacks } = await new StackReader().read([row(primary, "upper"), row(sibling, "lower")], [], [primary],
          async (key) => ({ repair: key === "codex:lower" }));
        expect(changed).toBe(true);
        expect(stacks[0]?.layers.find(({ branch }) => branch === "topic")?.heldBy)
          .toMatchObject({ branch: "lower", number: 1, reason: "repair in progress" });
      } finally {
        run.mockRestore();
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("verifies the other clone before binding a pathless PR after an alias retarget", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-retarget-provenance-"));
    const before = path.join(sandbox, "before");
    const after = path.join(sandbox, "after");
    const other = path.join(sandbox, "other");
    const alias = path.join(sandbox, "alias");
    const first = path.join(alias, "one");
    const second = path.join(alias, "two");
    try {
      await Promise.all([
        mkdir(path.join(before, "one"), { recursive: true }), mkdir(path.join(before, "two"), { recursive: true }),
        mkdir(path.join(after, "one"), { recursive: true }), mkdir(path.join(after, "two"), { recursive: true }), mkdir(other),
      ]);
      initialize(path.join(before, "one"));
      initialize(after);
      initialize(other);
      await writeCatalog(path.join(before, "one"), "before");
      const head = git(after, "rev-parse", "HEAD");
      git(after, "branch", "layer");
      await writeFile(path.join(after, ".git", "gh-stack"), JSON.stringify({
        schemaVersion: 1, repository: "github.com:fixture/after",
        stacks: [{ trunk: { branch: "main", head }, branches: [{ branch: "layer", head, base: head, pullRequest: { number: 2 } }] }],
      }));
      await symlink(before, alias, "junction");
      const runGitCommand = gitExecutable.runGitCommand;
      let moved = false;
      const run = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (!moved && cwd === first && args[0] === "rev-parse") {
          await rm(alias);
          await symlink(after, alias, "junction");
          moved = true;
        }
        return await runGitCommand(cwd, args, options);
      });
      try {
        const linked = row(second, "linked");
        const pr: PrSummary = {
          number: 2, provider: "github.com", org: "fixture", repo: "after", state: "passing", lifecycleState: "open",
          url: "https://github.com/fixture/after/pull/2", headRefName: "layer", baseRefName: "main", headSha: head,
        };
        const rows = [row(first, "trigger"), {
          ...linked, linkedDirectories: [...linked.linkedDirectories, ...row(other, "other").linkedDirectories], prs: [pr],
        }];
        const { stacks } = await new StackReader().read(rows, []);
        expect(moved).toBe(true);
        expect(await realpath(git(second, "rev-parse", "--show-toplevel"))).toBe(await realpath(after));
        expect(await realpath(git(other, "rev-parse", "--show-toplevel"))).toBe(await realpath(other));
        expect(stacks.find(({ repository }) => repository === "github.com:fixture/after")?.layers[0])
          .toMatchObject({ role: "unbound" });
      } finally {
        run.mockRestore();
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.each([
    ["bundled", "inferred", false], ["installed", "inferred", false],
    ["bundled", "tracked", false], ["bundled", "tracked", true],
  ] as const)("keeps %s Git scoped %s evidence inconclusive when a sibling checkout times out (override: %s)", async (runtime, kind, override) => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-inferred-sibling-"));
    const primary = path.join(sandbox, "primary");
    const sibling = path.join(sandbox, "sibling");
    try {
      await mkdir(primary);
      initialize(primary);
      git(primary, "config", "include.path", "fixture-git-include");
      git(primary, "worktree", "add", "-b", "lower", sibling);
      if (runtime === "installed") process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      let lowerPath = sibling;
      if (override) {
        process.env.GIT_CEILING_DIRECTORIES = sandbox;
        const nested = path.join(sibling, "nested");
        await mkdir(nested);
        lowerPath = path.join(sandbox, "lower-alias");
        await symlink(nested, lowerPath, "junction");
      }
      const head = git(primary, "rev-parse", "HEAD");
      const upper: PrSummary = {
        number: 2, provider: "github.com", org: "fixture", repo: "stack", state: "passing", lifecycleState: "open",
        url: "https://github.com/fixture/stack/pull/2", headRefName: "topic", baseRefName: "lower", headSha: head,
      };
      const lower: PrSummary = {
        ...upper, number: 1, url: "https://github.com/fixture/stack/pull/1", headRefName: "lower", baseRefName: "main",
      };
      if (kind === "tracked") {
        git(primary, "branch", "main");
        const layer = (branch: string, number: number) => ({ branch, head, base: head, pullRequest: { number } });
        await writeFile(path.join(primary, ".git", "gh-stack"), JSON.stringify({
          schemaVersion: 1, repository: "github.com:fixture/stack",
          stacks: [{ trunk: { branch: "main", head }, branches: [layer("lower", 1), layer("topic", 2)] }],
        }));
      }
      const rows = [
        { ...row(primary, "upper"), prs: [upper] },
        { ...row(lowerPath, "lower"), prs: kind === "tracked" ? [] : [lower] },
      ];
      const reader = new StackReader();
      const read = () => reader.read(rows, [], [primary], async (key) => ({ repair: key === "codex:lower" }));
      const stack = (await read()).stacks[0];
      expect(stack).toMatchObject({ inferred: kind === "inferred" });
      if (kind === "tracked") {
        expect(stack?.layers[1]?.heldBy).toMatchObject({ number: 1, reason: "repair in progress" });
      }
      const runGitCommand = gitExecutable.runGitCommand;
      const run = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation((cwd, args, options) =>
        cwd === lowerPath && args[0] === "rev-parse"
          ? Promise.reject(Object.assign(new Error("fixture sibling checkout timeout"), { killed: true }))
          : runGitCommand(cwd, args, options));
      try {
        const result = await read();
        if (kind === "inferred") expect(result.stacks).toEqual([]);
        expect(result.catalogs).toContainEqual({ status: "unavailable" });
      } finally {
        run.mockRestore();
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("revalidates Git discovery after an inline core.worktree symlink is retargeted", async () => {
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-inline-worktree-")));
    const repo = path.join(sandbox, "repo");
    const moved = path.join(sandbox, "moved");
    const alias = path.join(sandbox, "checkout");
    try {
      await Promise.all([mkdir(repo), mkdir(moved)]);
      initialize(repo);
      await writeCatalog(repo, "inline");
      await symlink(repo, alias, "junction");
      const config = path.join(repo, ".git", "config");
      await writeFile(config, (await readFile(config, "utf8")) + "\n[core] worktree = " + JSON.stringify(alias) + "\n");
      const discover = () => git(repo, "rev-parse", "--show-toplevel");
      const observation = new StackReadObservation();
      expect(discover()).toBe(repo);
      expect(await observation.preflightCatalogs([repo])).toMatchObject([{ status: "ok" }]);
      await rm(alias);
      await symlink(moved, alias, "junction");
      expect(discover()).toBe(moved);
      await observation.revalidateAfterListing();
      expect(await observation.checkoutsByClone([repo])).toMatchObject([{ root: moved }]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("builds fixtures without inheriting operator signing config", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-fixture-config-"));
    try {
      const config = path.join(sandbox, "operator.gitconfig");
      await writeFile(config, "[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = pwragent-fixture-no-signer\n");
      process.env.GIT_CONFIG_GLOBAL = config;
      initialize(sandbox);
      expect(git(sandbox, "rev-parse", "--verify", "HEAD")).toMatch(/^[a-f0-9]{40}$/);
      expect(process.env.GIT_CONFIG_GLOBAL).toBe(config);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("reuses a linked checkout after Git replaces the common reftable list", async (context) => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-reftable-"));
    const repo = path.join(sandbox, "primary");
    const sibling = path.join(sandbox, "sibling");
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      await mkdir(repo);
      try {
        git(repo, "init", "--ref-format=reftable", "-b", "topic");
      } catch (error) {
        if (String(error).includes("unknown option") && String(error).includes("ref-format")) {
          context.skip("Git cannot create a reftable fixture");
        }
        throw error;
      }
      const commit = () => git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "commit", "--allow-empty", "-m", "topic");
      commit();
      git(repo, "worktree", "add", "-b", "sibling", sibling);
      await writeCatalog(repo, "reftable");
      const tables = path.join(repo, ".git", "reftable", "tables.list");
      const initialTable = await readFile(tables, "utf8");
      const discover = () => git(sibling, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir");
      const initialCheckout = discover();
      const reader = new StackReader();
      const rows = [row(sibling, "sibling")];
      const checkoutStarts = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse").length;
      expect((await reader.read(rows, [])).stacks).toHaveLength(1);
      expect(checkoutStarts()).toBe(1);
      commit();
      expect(await readFile(tables, "utf8")).not.toBe(initialTable);
      expect(discover()).toBe(initialCheckout);
      expect((await reader.read(rows, [])).stacks).toHaveLength(1);
      expect(checkoutStarts()).toBe(1);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("rechecks both sibling paths when a shared alias moves to a tracked clone", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-shared-retarget-"));
    const before = path.join(sandbox, "before");
    const after = path.join(sandbox, "after");
    const alias = path.join(sandbox, "thread");
    const first = path.join(alias, "one");
    const second = path.join(alias, "two");
    try {
      await Promise.all([before, after].flatMap((root) => ["one", "two"].map((child) =>
        mkdir(path.join(root, child), { recursive: true }))));
      initialize(path.join(before, "one"));
      initialize(after);
      await Promise.all([writeCatalog(path.join(before, "one"), "before"), writeCatalog(after, "after")]);
      await symlink(before, alias, "junction");
      const runGitCommand = gitExecutable.runGitCommand;
      let moved = false;
      const run = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (!moved && cwd === first && args[0] === "rev-parse") {
          await rm(alias);
          await symlink(after, alias, "junction");
          moved = true;
        }
        return await runGitCommand(cwd, args, options);
      });
      try {
        const result = await new StackReader().read([row(first, "one"), row(second, "two")], []);
        expect(moved).toBe(true);
        for (const cwd of [first, second]) {
          expect(await realpath(git(cwd, "rev-parse", "--show-toplevel"))).toBe(await realpath(after));
        }
        expect(result.stacks).toHaveLength(1);
        expect(result.stacks[0]?.repository).toBe("github.com:fixture/after");
        expect(result.stacks[0]?.layers[0]).toMatchObject({ role: "ambiguous" });
      } finally {
        run.mockRestore();
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("admits the catalog Git finds when a checkout moves after the inventory hint", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-moved-after-hint-"));
    const before = path.join(sandbox, "before");
    const after = path.join(sandbox, "after");
    const alias = path.join(sandbox, "thread");
    try {
      await Promise.all([mkdir(before), mkdir(after)]);
      initialize(before);
      initialize(after);
      await Promise.all([writeCatalog(before, "before"), writeCatalog(after, "after")]);
      await symlink(before, alias, "junction");
      const runGitCommand = gitExecutable.runGitCommand;
      let moved = false;
      const run = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (!moved && cwd === alias && args[0] === "rev-parse") {
          await rm(alias);
          await symlink(after, alias, "junction");
          expect(await realpath(git(alias, "rev-parse", "--path-format=absolute", "--git-common-dir")))
            .toBe(await realpath(path.join(after, ".git")));
          moved = true;
        }
        return await runGitCommand(cwd, args, options);
      });
      try {
        const result = await new StackReader().read([row(alias, "thread")], []);
        expect(moved).toBe(true);
        expect(result.stacks.map(({ repository }) => repository)).toEqual(["github.com:fixture/after"]);
      } finally {
        run.mockRestore();
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("keeps scoped Git launches independent of thread paths outside the selected clone", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-demand-"));
    const selected = path.join(sandbox, "selected");
    const unrelated = path.join(sandbox, "unrelated");
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      await Promise.all([mkdir(selected), mkdir(unrelated)]);
      initialize(selected);
      git(unrelated, "init", "-b", "main");
      await writeCatalog(selected, "selected");
      const selectedRow = row(selected, "selected");
      const run = async (extra: readonly ReturnType<typeof row>[]) => {
        start.mockClear();
        const result = await new StackReader().read([selectedRow, ...extra], [], [selected]);
        return { result, starts: start.mock.calls.map(([cwd, args]) => `${cwd}\0${args[0]}`).sort() };
      };
      const scoped = await run([]);
      expect(scoped.result.stacks[0]?.layers[0]?.thread?.key).toBe("codex:selected");
      await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.nat({ max: 31 }), { minLength: 2, maxLength: 12 }), async (inventory) => {
        const extra = await Promise.all(inventory.map(async (index) => {
          const cwd = path.join(index % 3 === 0 ? unrelated : sandbox, "fixture-" + index);
          if (index % 3 !== 2) await mkdir(cwd, { recursive: true });
          return row(cwd, "fixture-" + index);
        }));
        expect(await run(extra)).toEqual(scoped);
      }), { numRuns: 12 });
      const ordinary = path.join(sandbox, "ordinary");
      await mkdir(ordinary);
      expect(await run([row(ordinary, "ordinary")])).toEqual(scoped);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });
  it("takes new Git evidence when a scoped symlink changes to a distinct clone", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-rebind-"));
    try {
      const first = path.join(sandbox, "first");
      const second = path.join(sandbox, "second");
      const alias = path.join(sandbox, "alias");
      await Promise.all([mkdir(first), mkdir(second)]);
      initialize(first);
      initialize(second);
      await Promise.all([writeCatalog(first, "same-repository"), writeCatalog(second, "same-repository")]);
      const reader = new StackReader();
      const rows = [row(alias, "alias")];
      const read = async (root: string, observation?: StackReadObservation) => {
        const [physical] = await readStackClones([alias]);
        expect(physical?.root).toBe(await realpath(root));
        const { stacks } = await reader.read(rows, [], [alias], undefined, observation);
        expect(stacks[0]?.layers[0]?.thread?.key).toBe("codex:alias");
        return stacks[0]?.key;
      };
      await symlink(first, alias, "junction");
      const firstKey = await read(first);
      const observation = new StackReadObservation();
      expect((await observation.preflightCatalogs([alias]))[0]?.status).toBe("ok");
      await rm(alias);
      await symlink(second, alias, "junction");
      await observation.revalidateAfterListing();
      const secondKey = await read(second, observation);
      expect(secondKey).toBeDefined();
      expect(secondKey).not.toBe(firstKey);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("projects clones in the same order under reversed checkout completion", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-ordered-"));
    try {
      const first = path.join(sandbox, "first");
      const second = path.join(sandbox, "second");
      await Promise.all([mkdir(first), mkdir(second)]);
      initialize(first);
      initialize(second);
      await Promise.all([writeCatalog(first, "first"), writeCatalog(second, "second")]);
      const rows = [{
        ...row(first, "linked"),
        linkedDirectories: [...row(first, "first").linkedDirectories, ...row(second, "second").linkedDirectories],
      }];
      const reader = new StackReader();
      await reader.read(rows, []);
      const read = async (delayed: string) => {
        const observation = new StackReadObservation();
        const identity = observation.hints.checkoutIdentity.bind(observation.hints);
        const firstComplete = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        vi.spyOn(observation.hints, "checkoutIdentity").mockImplementation(async (cwd) => {
          const found = await identity(cwd);
          if (cwd === delayed) await resume.promise;
          else firstComplete.resolve();
          return found;
        });
        const pending = reader.read(rows, [], undefined, undefined, observation);
        await firstComplete.promise;
        // Let the ready checkout reach the mapper's consumer before releasing
        // the other observation. This advances scheduling without a time delay.
        await new Promise<void>((resolve) => setImmediate(resolve));
        resume.resolve();
        return await pending;
      };
      const left = await read(first);
      const right = await read(second);
      expect(left).toEqual(right);
      expect(left.stacks.map(({ repository }) => repository)).toEqual(["github.com:fixture/first", "github.com:fixture/second"]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("follows a commondir retarget that differs by a trailing space", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-common-pointer-"));
    try {
      const primary = path.join(sandbox, "primary");
      const worktree = path.join(sandbox, "worktree");
      await mkdir(primary);
      initialize(primary);
      git(primary, "worktree", "add", "-b", "sibling", worktree);
      await writeCatalog(primary, "first");
      const common = path.join(primary, ".git");
      const retargeted = common + " ";
      const pointer = path.join(git(worktree, "rev-parse", "--absolute-git-dir"), "commondir");
      await writeFile(pointer, common + "\n");
      await cp(common, retargeted, { recursive: true });
      const catalogPath = path.join(retargeted, "gh-stack");
      const catalog = (await readFile(catalogPath, "utf8")).replace("fixture/first", "fixture/second");
      await writeFile(catalogPath, catalog);
      const gitCommonDirectory = () => runIsolatedGitSync(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .replace(/\n$/, "");
      const reader = new StackReader();
      const rows = [row(worktree, "worktree")];
      expect(await realpath(gitCommonDirectory())).toBe(await realpath(common));
      expect((await reader.read(rows, [])).stacks.map(({ repository }) => repository)).toEqual(["github.com:fixture/first"]);
      expect((await reader.read(rows, [])).stacks.map(({ repository }) => repository)).toEqual(["github.com:fixture/first"]);
      await writeFile(pointer, retargeted + "\n");
      expect(await realpath(gitCommonDirectory())).toBe(await realpath(retargeted));
      expect((await reader.read(rows, [])).stacks.map(({ repository }) => repository)).toEqual(["github.com:fixture/second"]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("rechecks the scoped anchor without relaunching Git for unchanged sibling worktrees", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-scoped-warm-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      const primary = path.join(sandbox, "primary");
      const sibling = path.join(sandbox, "sibling");
      await mkdir(primary);
      initialize(primary);
      git(primary, "worktree", "add", "-b", "sibling", sibling);
      await writeCatalog(primary, "scoped");
      const reader = new StackReader();
      const rows = [row(primary, "primary"), row(sibling, "sibling")];
      const first = await reader.read(rows, [], [primary]);
      expect(first.stacks).toHaveLength(1);
      start.mockClear();
      expect(await reader.read(rows, [], [primary])).toEqual(first);
      expect(start.mock.calls.filter(([, args]) => args[0] === "rev-parse").map(([cwd]) => cwd)).toEqual([primary]);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("reuses verified inventory checkouts until their physical relationship changes", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-warm-inventory-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      const primary = path.join(sandbox, "primary");
      const sibling = path.join(sandbox, "sibling");
      const other = path.join(sandbox, "other");
      const alias = path.join(sandbox, "alias");
      await Promise.all([mkdir(primary), mkdir(other)]);
      initialize(primary);
      initialize(other);
      git(primary, "worktree", "add", "-b", "sibling", sibling);
      await Promise.all([writeCatalog(primary, "primary"), writeCatalog(other, "other")]);
      await symlink(sibling, alias, "junction");
      const reader = new StackReader();
      const checkoutStarts = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse").map(([cwd]) => cwd);
      const rows = [row(primary, "primary"), row(alias, "alias")];
      await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.nat({ max: 15 }), { minLength: 2, maxLength: 8 }), async (inventory) => {
        const subdirectories = await Promise.all(inventory.map(async (index) => {
          const cwd = path.join(sibling, "fixture-" + index);
          await mkdir(cwd, { recursive: true });
          return row(cwd, "fixture-" + index);
        }));
        const coldReader = new StackReader();
        const cold = await coldReader.read([...rows, ...subdirectories], []);
        start.mockClear();
        expect(await coldReader.read([...rows, ...subdirectories], [])).toEqual(cold);
        expect(checkoutStarts()).toEqual([]);
      }), { numRuns: 6 });
      const scoped = await reader.read([row(alias, "alias")], [], [alias]);
      expect(scoped.stacks[0]?.repository).toBe("github.com:fixture/primary");
      await reader.read(rows, []);
      await rm(alias);
      await symlink(other, alias, "junction");
      start.mockClear();
      const rebound = await reader.read(rows, []);
      expect(checkoutStarts()).toEqual([alias]);
      expect(rebound.stacks.find((stack) => stack.repository === "github.com:fixture/other")?.layers[0]?.thread?.key)
        .toBe("codex:alias");
      start.mockClear();
      expect((await reader.read([row(alias, "alias")], [], [alias])).stacks[0]?.repository).toBe("github.com:fixture/other");
      expect(checkoutStarts()).toEqual([alias]);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.each(["refs", "objects"])("follows Git discovery when a warmed nested repository loses %s", async (entry) => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-discovery-change-"));
    try {
      initialize(sandbox);
      const nested = path.join(sandbox, "nested");
      await mkdir(nested);
      initialize(nested);
      await Promise.all([writeCatalog(sandbox, "outer"), writeCatalog(nested, "nested")]);
      const reader = new StackReader();
      const rows = [row(nested, "nested")];
      const observedRepository = async () => {
        const top = await realpath(git(nested, "rev-parse", "--show-toplevel"));
        return top === await realpath(nested) ? "github.com:fixture/nested" : "github.com:fixture/outer";
      };
      expect((await reader.read(rows, [])).stacks.map(({ repository }) => repository)).toEqual([await observedRepository()]);
      const metadata = path.join(nested, ".git", entry);
      await rename(metadata, metadata + ".saved");
      expect(await observedRepository()).toBe("github.com:fixture/outer");
      expect((await reader.read(rows, [])).stacks.map(({ repository }) => repository)).toEqual([await observedRepository()]);
      await rename(metadata + ".saved", metadata);
      expect(await observedRepository()).toBe("github.com:fixture/nested");
      expect((await reader.read(rows, [])).stacks.map(({ repository }) => repository)).toEqual([await observedRepository()]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("follows Git when a HEAD symlink changes without changing its referent", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-head-link-"));
    try {
      const nested = path.join(sandbox, "nested");
      await mkdir(nested);
      initialize(sandbox);
      initialize(nested);
      await Promise.all([writeCatalog(sandbox, "outer"), writeCatalog(nested, "nested")]);
      const head = path.join(nested, ".git", "HEAD");
      const target = "refs/heads/topic";
      const retarget = async (value: string) => {
        await rm(head);
        await symlink(value, head);
      };
      const reader = new StackReader();
      const project = async () => (await reader.read([row(nested, "nested")], [])).stacks.map(({ repository }) => repository);
      const gitRoot = async () => await realpath(git(nested, "rev-parse", "--show-toplevel"));
      await retarget(target);
      const referent = await realpath(head);
      expect(await gitRoot()).toBe(await realpath(nested));
      expect(await project()).toEqual(["github.com:fixture/nested"]);
      expect(await project()).toEqual(["github.com:fixture/nested"]);
      await retarget("./" + target);
      expect(await realpath(head)).toBe(referent);
      expect(await gitRoot()).toBe(await realpath(sandbox));
      expect(await project()).toEqual(["github.com:fixture/outer"]);
      await retarget(target);
      expect(await gitRoot()).toBe(await realpath(nested));
      expect(await project()).toEqual(["github.com:fixture/nested"]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("checks a catalog created after a negative fleet read and uses Git under discovery overrides", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-admission-"));
    try {
      const external = path.join(sandbox, "external");
      const local = path.join(sandbox, "local");
      await Promise.all([mkdir(external), mkdir(local)]);
      initialize(external);
      initialize(local);
      const reader = new StackReader();
      const rows = [row(local, "local")];
      expect((await reader.read(rows, [])).stacks).toEqual([]);
      await writeCatalog(local, "local");
      expect((await reader.read(rows, [])).stacks[0]?.repository).toBe("github.com:fixture/local");
      await rename(path.join(local, ".git", "gh-stack"), path.join(local, ".git", "saved-stack"));
      expect((await reader.read(rows, [])).stacks).toEqual([]);

      await writeCatalog(external, "external");
      vi.stubEnv("GIT_DIR", path.join(external, ".git"));
      vi.stubEnv("GIT_WORK_TREE", local);
      expect((await reader.read(rows, [])).stacks[0]?.repository).toBe("github.com:fixture/external");
    } finally {
      vi.unstubAllEnvs();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("infers and holds layers across linked worktrees of one physical clone", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-inferred-stack-"));
    try {
      const lower = path.join(sandbox, "lower");
      const upper = path.join(sandbox, "upper");
      const other = path.join(sandbox, "other-clone");
      await Promise.all([mkdir(lower), mkdir(other)]);
      initialize(lower);
      initialize(other);
      git(lower, "worktree", "add", "-b", "upper", upper);
      const pr = (number: number, headRefName: string, baseRefName: string, cwd: string): PrSummary => ({
        number, provider: "github.com", org: "fixture", repo: "shared", lifecycleState: "open", state: "passing",
        headRefName, baseRefName, url: `https://github.com/fixture/shared/pull/${number}`, linkedDirectoryPaths: [cwd],
      });
      const bottomPr = pr(1, "topic", "main", lower);
      const topPr = pr(2, "upper", "topic", upper);
      const rows = [
        { ...row(lower, "lower"), prs: [bottomPr] },
        { ...row(upper, "upper"), prs: [topPr] },
        { ...row(other, "other"), prs: [pr(1, "topic", "main", other)] },
      ];
      const reader = new StackReader();
      const activity = async (key: string) => ({ held: key === "codex:lower" });
      const scoped = await reader.read(rows, [], [upper], activity);
      expect(scoped.stacks).toHaveLength(1);
      expect(scoped.stacks[0]).toMatchObject({
        inferred: true,
        layers: [
          { branch: "topic", health: "held", thread: { key: "codex:lower" } },
          { branch: "upper", thread: { key: "codex:upper" }, heldBy: { number: 1 } },
        ],
      });
      expect((await reader.read(rows, [], undefined, activity)).stacks).toEqual(scoped.stacks);
      expect((await reader.read(rows, [bottomPr, topPr], [other], activity)).stacks).toEqual([]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("keeps checking a bare layout with a worktree even when an invalid .git directory exists", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-bare-layout-"));
    try {
      git(sandbox, "init", "--bare", "-b", "topic");
      git(sandbox, "config", "core.bare", "false");
      git(sandbox, "config", "core.worktree", sandbox);
      await mkdir(path.join(sandbox, ".git"));
      git(sandbox, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "topic");
      expect(await realpath(git(sandbox, "rev-parse", "--path-format=absolute", "--git-common-dir"))).toBe(await realpath(sandbox));
      await writeCatalog(sandbox, "bare-layout");
      expect((await new StackReader().read([row(sandbox, "bare")], [])).stacks[0]?.repository).toBe("github.com:fixture/bare-layout");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("preserves literal carriage returns in Git checkout paths", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-line-ending-"));
    try {
      const cwd = path.join(sandbox, "checkout\r");
      await mkdir(cwd);
      initialize(cwd);
      await writeCatalog(cwd, "line-ending");
      const [checkout] = await readStackClones([cwd]);
      expect(checkout?.root).toBe(await realpath(cwd));
      expect(checkout?.catalog.status).toBe("ok");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("falls back to Git while an unrelated filesystem hint is still stalled", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-stalled-hint-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    const originalStat = vi.mocked(lstat).getMockImplementation()!;
    let resume!: () => void;
    const stalled = new Promise<void>((resolve) => { resume = resolve; });
    try {
      const selected = path.join(sandbox, "selected");
      const unrelated = path.join(sandbox, "unrelated");
      await mkdir(selected);
      initialize(selected);
      await writeCatalog(selected, "selected");
      vi.mocked(lstat).mockImplementation((...args) => String(args[0]) === unrelated
        ? stalled.then(() => originalStat(...args)) : originalStat(...args));
      const { stacks } = await new StackReader().read([row(selected, "selected"), row(unrelated, "unrelated")], [], [selected]);
      expect(stacks[0]?.layers[0]?.thread?.key).toBe("codex:selected");
      expect(start.mock.calls.filter(([cwd]) => cwd === unrelated).map(([, args]) => args[0])).toEqual(["rev-parse"]);
    } finally {
      vi.mocked(lstat).mockImplementation(originalStat);
      start.mockRestore();
      resume();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("reuses a verified preflight only while checkout and catalog evidence still agree", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-preflight-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      initialize(sandbox);
      await writeCatalog(sandbox, "preflight");
      const reader = new StackReader();
      const rows = [row(sandbox, "preflight")];
      const project = async () => {
        const observation = new StackReadObservation();
        expect((await observation.preflightCatalogs([sandbox]))[0]?.status).toBe("ok");
        await observation.revalidateAfterListing();
        expect((await reader.read(rows, [], [sandbox], undefined, observation)).stacks).toHaveLength(1);
      };
      vi.mocked(open).mockClear();
      await project();
      const checkoutStarts = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse");
      expect(checkoutStarts()).toHaveLength(1);
      expect(vi.mocked(open).mock.calls.filter(([file]) => path.basename(String(file)) === "gh-stack")).toHaveLength(1);
      await project();
      expect(checkoutStarts()).toHaveLength(2);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("revalidates an enclosing checkout shadowed by an unborn HEAD symlink", async () => {
    const outer = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-shadowed-checkout-")));
    const nested = path.join(outer, "nested");
    const cwd = path.join(nested, "thread");
    try {
      initialize(outer);
      await writeCatalog(outer, "outer");
      await mkdir(cwd, { recursive: true });
      const observation = new StackReadObservation();
      const discover = () => git(cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir").split("\n");
      expect(discover()).toEqual([outer, path.join(outer, ".git")]);
      expect(await observation.preflightCatalogs([cwd])).toMatchObject([{ status: "ok" }]);

      git(nested, "init", "--bare");
      git(nested, "--git-dir=.", "config", "core.bare", "false");
      git(nested, "--git-dir=.", "config", "core.worktree", nested);
      const head = path.join(nested, "HEAD");
      await rm(head);
      await symlink("refs/heads/unborn", head);
      const [root, commonDir] = discover();
      expect([root, commonDir]).toEqual([nested, nested]);
      await observation.revalidateAfterListing();
      expect(await observation.checkoutsByClone([cwd])).toEqual([{ cwd, root, commonDir }]);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it("reuses verified positive and negative inventory with an installed Git", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-installed-git-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      const tracked = path.join(sandbox, "tracked");
      const ordinary = path.join(sandbox, "ordinary");
      const missing = path.join(sandbox, "missing");
      await Promise.all([mkdir(tracked), mkdir(ordinary)]);
      initialize(tracked);
      initialize(ordinary);
      await writeCatalog(tracked, "tracked");
      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      let now = 0;
      const reader = new StackReader(() => now);
      const rows = [row(tracked, "tracked"), row(ordinary, "ordinary"), row(missing, "missing")];
      const count = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse").length;
      const cold = await reader.read(rows, []);
      expect(cold.stacks).toHaveLength(1);
      expect(count()).toBe(3);
      start.mockClear();
      expect(await reader.read(rows, [])).toEqual(cold);
      expect(count()).toBe(0);
      await reader.read(rows, [], [tracked]);
      expect(count()).toBe(1);

      await mkdir(missing);
      initialize(missing);
      await writeCatalog(missing, "new");
      start.mockClear();
      expect((await reader.read(rows, [])).stacks).toHaveLength(2);
      expect(count()).toBe(1);
      start.mockClear();
      now += 31_000;
      expect((await reader.read(rows, [])).stacks).toHaveLength(2);
      expect(count()).toBe(3);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("reopens the published catalog when an atomic replacement races the first handle", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-replaced-catalog-"));
    const originalOpen = vi.mocked(open).getMockImplementation()!;
    try {
      initialize(sandbox);
      await writeCatalog(sandbox, "before");
      const common = path.join(sandbox, ".git");
      const catalogPath = path.join(common, "gh-stack");
      const replacement = catalogPath + ".new";
      await writeFile(replacement, (await readFile(catalogPath, "utf8")).replace("fixture/before", "fixture/after"));
      let replaced = false;
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === catalogPath && !replaced) {
          const stat = handle.stat.bind(handle);
          let stats = 0;
          vi.spyOn(handle, "stat").mockImplementation(async (...options) => {
            const info = await stat(...options);
            if (++stats === 2) {
              // Replace after the read and handle checks. Windows can reject
              // replacing a destination that still has an open handle.
              await handle.close();
              await rename(replacement, catalogPath);
              replaced = true;
            }
            return info;
          });
        }
        return handle;
      });
      const catalog = await readGhStackCatalog(common);
      expect(replaced).toBe(true);
      expect(catalog).toMatchObject({ status: "ok", catalog: { repository: "github.com:fixture/after" } });
    } finally {
      vi.mocked(open).mockImplementation(originalOpen);
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("shares installed-Git checkout evidence across background preflights only", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-shared-preflight-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      initialize(sandbox);
      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      const reader = new StackReader();
      const count = () => start.mock.calls.filter(([, args]) => args[0] === "rev-parse").length;
      const background = () => reader.preflightCatalogs([sandbox], new StackReadObservation());
      expect(await Promise.all(Array.from({ length: 4 }, background))).toEqual(Array.from({ length: 4 }, () => [{ status: "missing" }]));
      expect(count()).toBe(1);
      await background();
      expect(count()).toBe(1);
      await writeCatalog(sandbox, "new");
      expect(await background()).toMatchObject([{ status: "ok" }]);
      expect(count()).toBe(1);
      await reader.preflightCatalogs([sandbox], new StackReadObservation({ priority: () => PR_METADATA_PRIORITY.selected }));
      expect(count()).toBe(2);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent scoped inventory lookups while checking each explicit anchor live", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-shared-inventory-"));
    const primary = path.join(sandbox, "primary");
    const sibling = path.join(sandbox, "sibling");
    const releaseLookup = Promise.withResolvers<void>();
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      await mkdir(primary);
      initialize(primary);
      git(primary, "worktree", "add", "-b", "sibling", sibling);
      await writeCatalog(primary, "shared");
      const reader = new StackReader();
      const observations = [new StackReadObservation(), new StackReadObservation()];
      let siblingWitnesses = 0;
      for (const observation of observations) {
        const witness = observation.hints.checkoutIdentity.bind(observation.hints);
        observation.hints.checkoutIdentity = async (cwd) => {
          const result = await witness(cwd);
          if (cwd === sibling && result) siblingWitnesses++;
          return result;
        };
      }
      const runGitCommand = gitExecutable.runGitCommand;
      const run = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (cwd === sibling && args[0] === "rev-parse") await releaseLookup.promise;
        return await runGitCommand(cwd, args, options);
      });
      const rows = [row(primary, "primary"), row(sibling, "sibling")];
      const reads = Promise.allSettled(observations.map((observation) => reader.read(rows, [], [primary], undefined, observation)));
      try {
        await vi.waitFor(() => expect(siblingWitnesses).toBe(2));
        await runPrMetadataProcess(async () => {});
        releaseLookup.resolve();
        expect((await reads).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
        const checkoutStarts = (cwd: string) => start.mock.calls.filter(([path, args]) => path === cwd && args[0] === "rev-parse").length;
        expect(checkoutStarts(primary)).toBe(2);
        expect(checkoutStarts(sibling)).toBe(1);
      } finally {
        releaseLookup.resolve();
        await reads;
        run.mockRestore();
      }
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("keeps ordinary catalog preflights launch-free until a catalog appears", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-ordinary-offer-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      initialize(sandbox);
      const reader = new StackReader();
      const read = () => reader.preflightCatalogs([sandbox], new StackReadObservation());
      for (let pass = 0; pass < 3; pass++) {
        expect(await read()).toEqual([]);
      }
      expect(start).not.toHaveBeenCalled();
      await writeCatalog(sandbox, "offer");
      expect(await read()).toMatchObject([{ status: "ok" }]);
      expect(start.mock.calls.map(([, args]) => args[0])).toEqual(["rev-parse"]);
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("does not admit a shared Git preflight after cancellation at the checkout hint boundary", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-canceled-shared-preflight-"));
    const controller = new AbortController();
    const reason = new Error("Preflight canceled");
    try {
      initialize(sandbox);
      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      const run = vi.spyOn(gitExecutable, "runGitCommand").mockResolvedValue({
        stdout: sandbox + "\n" + path.join(sandbox, ".git") + "\n", stderr: "",
      });
      try {
        const observation = new StackReadObservation({ signal: controller.signal });
        const checkoutIdentity = observation.hints.checkoutIdentity.bind(observation.hints);
        let probes = 0;
        observation.hints.checkoutIdentity = async (cwd) => {
          const result = await checkoutIdentity(cwd);
          expect(result).toBeDefined();
          if (++probes === 2) controller.abort(reason);
          return result;
        };
        await expect(new StackReader().preflightCatalogs([sandbox], observation)).rejects.toBe(reason);
        // Let the metadata queue admit anything already submitted at the
        // canceled request's priority before checking its Git calls.
        await runPrMetadataProcess(async () => {});
        expect(probes).toBe(2);
        expect(run).not.toHaveBeenCalled();
      } finally {
        run.mockRestore();
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("skips Git for startup recovery when the checkouts have no journal", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-recovery-demand-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      initialize(sandbox);
      await writeCatalog(sandbox, "without-journal");
      const child = path.join(sandbox, "child");
      await mkdir(child);
      const registry = {} as DesktopBackendRegistry;
      expect(await new StackOperationsService().resumeInterrupted([sandbox, child], registry)).toEqual([]);
      expect(start).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("keeps the subprocess timeout separate from the request signal", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-subprocess-timeout-"));
    const run = vi.spyOn(gitExecutable, "runGitCommand");
    try {
      initialize(sandbox);
      const { signal } = new AbortController();
      await expect(readStackClones([sandbox], { signal })).resolves.toHaveLength(1);
      expect(run.mock.calls[0]?.[2]).toMatchObject({
        timeout: 3_000, purpose: "stack-checkout", ownProcessTree: true,
      });
      expect(run.mock.calls[0]?.[2]?.signal).toBe(signal);
    } finally {
      run.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("drains the descendant of a canceled POSIX stack checkout", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-owned-checkout-"));
    const wrapper = path.join(sandbox, "git-wrapper");
    const script = path.join(sandbox, "hold.cjs");
    const pidFile = path.join(sandbox, "descendant.pid");
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const controller = new AbortController();
    let pid = 0;
    try {
      await writeFile(script, [
        'require("node:fs").writeFileSync(process.argv[2], String(process.pid));',
        "setInterval(() => {}, 1000);",
      ].join("\n"));
      await writeFile(wrapper, [
        "#!/bin/sh",
        'cd "$2" || exit',
        `${quote(process.execPath)} ${quote(script)} ${quote(pidFile)} </dev/null >/dev/null 2>&1 &`,
        "child=$!",
        "trap 'wait \"$child\"; exit 130' TERM",
        'wait "$child"',
      ].join("\n") + "\n", { mode: 0o700 });
      process.env.PWRAGENT_GIT_PATH = wrapper;
      const reading = readStackClones([sandbox], { signal: controller.signal }).catch((error: unknown) => error);
      await vi.waitFor(async () => {
        pid = Number(await readFile(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
      }, { timeout: 2_000 });
      const reason = new Error("Selection changed");
      controller.abort(reason);
      expect(await reading).toBe(reason);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* The wrapper has reaped its child. */ }
      }
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("cancels a queued scoped read before it can launch Git", async () => {
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      const controller = new AbortController();
      const reason = new Error("Selection changed");
      const result = new StackReader().read([], [], [os.tmpdir()], undefined, new StackReadObservation({ signal: controller.signal }));
      controller.abort(reason);
      await expect(result).rejects.toBe(reason);
      expect(start).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  });

});
