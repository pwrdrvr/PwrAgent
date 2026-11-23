import { execFileSync } from "node:child_process";
import { cp, lstat, open, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as gitExecutable from "../app-server/git-executable";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { PR_METADATA_PRIORITY } from "../pr-status/pr-metadata-process";
import { StackOperationsService } from "../stacks/stack-operations-service";
import { StackReader, StackReadObservation, readGhStackCatalog, readStackClones } from "../stacks/stack-reader";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";

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

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

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
      const gitCommonDirectory = () => execFileSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).replace(/\n$/, "");
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
          vi.spyOn(handle, "stat").mockImplementationOnce(async (...options) => {
            const info = await stat(...options);
            await rename(replacement, catalogPath);
            replaced = true;
            return info;
          });
        }
        return handle;
      });
      expect(await readGhStackCatalog(common)).toMatchObject({ status: "ok", catalog: { repository: "github.com:fixture/after" } });
      expect(replaced).toBe(true);
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

  it("keeps ordinary catalog preflights launch-free until a catalog appears", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-ordinary-offer-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      initialize(sandbox);
      for (let pass = 0; pass < 3; pass++) {
        expect(await new StackReadObservation().presentCatalogs([sandbox])).toEqual([]);
      }
      expect(start).not.toHaveBeenCalled();
      await writeCatalog(sandbox, "offer");
      expect(await new StackReadObservation().presentCatalogs([sandbox])).toMatchObject([{ status: "ok" }]);
      expect(start.mock.calls.map(([, args]) => args[0])).toEqual(["rev-parse"]);
    } finally {
      start.mockRestore();
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
        timeout: 3_000, purpose: "stack-checkout", ownProcessTree: process.platform === "win32",
      });
      expect(run.mock.calls[0]?.[2]?.signal).toBe(signal);
    } finally {
      run.mockRestore();
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
