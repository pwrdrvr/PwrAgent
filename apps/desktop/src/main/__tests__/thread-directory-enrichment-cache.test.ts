import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadDirectoryEnricher } from "../app-server/thread-directory-enricher";
import budgets from "./fixtures/git-subprocess-budgets.json";

const git = vi.hoisted(() => vi.fn());
const readPointer = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  readPointer.mockImplementation(actual.readFile);
  return { ...actual, readFile: readPointer };
});
vi.mock("node:child_process", () => ({ execFile: git }));
vi.mock("../git-command", () => ({ getGitCommand: () => "git" }));
vi.mock("../log", () => ({
  getMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root: string;
let repo: string;
let branch: string;
let fail: boolean;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-directory-cache-")));
  repo = path.join(root, "repo");
  branch = "main";
  fail = false;
  readPointer.mockClear();
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  await fs.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  git.mockReset();
  git.mockImplementation((
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    if (fail) return callback(new Error("git temporarily unavailable"));
    const stdout = args.includes("--show-toplevel") ? args[1]
      : args.includes("--porcelain") ? `worktree ${repo}\nworktree ${args[1]}\n`
      : branch;
    callback(null, { stdout, stderr: "" });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function initializeRealGit(initOptions: string[] = []) {
  const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile("git", args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  await fs.rm(path.join(repo, ".git"), { recursive: true });
  await run(["init", "--initial-branch=main", ...initOptions, repo]);
  await run(["-C", repo, "config", "core.hooksPath", path.join(root, "empty-hooks")]);
  await run(["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
  git.mockImplementation((
    command: string, args: string[], options: object,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    callback(error, { stdout, stderr });
  }));
  return run;
}

describe("directory enrichment invalidation", () => {
  it("keeps a confirmed mapping across a day of repeated reads without Git", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const enrich = createThreadDirectoryEnricher();
    const first = await enrich(repo);
    git.mockClear();
    for (let round = 1; round <= budgets.directoryEnrichment.repeatedListings; round += 1) {
      now.mockReturnValue(1_000 + round * 86_400_000);
      expect(await enrich(repo)).toEqual(first);
    }
    expect(git).toHaveBeenCalledTimes(budgets.directoryEnrichment.warmGitCommands);
  });

  it("refreshes only branch data immediately after an external checkout", async () => {
    const enrich = createThreadDirectoryEnricher();
    const first = await enrich(repo);
    git.mockClear();
    branch = "feature/changed";
    await fs.writeFile(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    expect(await enrich(repo)).toEqual({ ...first, observedGitBranch: branch });
    expect(git.mock.calls.map((call) => call[1].slice(2)))
      .toEqual([["rev-parse", "--abbrev-ref", "HEAD"]]);
    expect(git).toHaveBeenCalledTimes(budgets.directoryEnrichment.branchChangeGitCommands);
  });

  it("forgets a removed directory immediately and resolves its replacement", async () => {
    const enrich = createThreadDirectoryEnricher();
    await enrich(repo);
    await fs.rm(repo, { recursive: true });
    expect(await enrich(repo)).toEqual({ linkedDirectories: [] });
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    branch = "replacement";
    await fs.writeFile(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    expect((await enrich(repo)).observedGitBranch).toBe(branch);
  });

  it("retries failed probes immediately instead of retaining a fallback", async () => {
    const enrich = createThreadDirectoryEnricher();
    fail = true;
    expect((await enrich(repo)).observedGitBranch).toBeUndefined();
    fail = false;
    expect((await enrich(repo)).observedGitBranch).toBe("main");
  });

  it("discovers a new nested repository without expiring the outer mapping", async () => {
    const nested = path.join(repo, "nested");
    await fs.mkdir(nested);
    const enrich = createThreadDirectoryEnricher();
    await enrich(nested);
    git.mockClear();
    await fs.mkdir(path.join(nested, ".git"));
    await fs.writeFile(path.join(nested, ".git", "HEAD"), "ref: refs/heads/nested\n");
    branch = "nested";
    expect((await enrich(nested)).observedGitBranch).toBe("nested");
    expect(git).toHaveBeenCalledTimes(3);
  });

  it("shares aliases and simultaneous validations for the same directory", async () => {
    const enrich = createThreadDirectoryEnricher();
    await Promise.all([enrich(repo), enrich(`${repo}${path.sep}.`), enrich(` ${repo} `)]);
    expect(git).toHaveBeenCalledTimes(3);
  });

  it("invalidates a worktree mapping when its gitdir link changes", async () => {
    const worktree = path.join(root, "worktree");
    const admin = path.join(repo, ".git", "worktrees", "first");
    await fs.mkdir(admin, { recursive: true });
    await fs.mkdir(worktree);
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${admin}\n`);
    await fs.writeFile(path.join(admin, "commondir"), "../..\n");
    await fs.writeFile(path.join(admin, "HEAD"), "ref: refs/heads/main\n");
    const enrich = createThreadDirectoryEnricher();
    await enrich(worktree);
    git.mockClear();
    const nextAdmin = path.join(repo, ".git", "worktrees", "second");
    await fs.mkdir(nextAdmin);
    await fs.writeFile(path.join(nextAdmin, "commondir"), "../..\n");
    await fs.writeFile(path.join(nextAdmin, "HEAD"), "ref: refs/heads/second\n");
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${nextAdmin}\n`);
    branch = "second";
    expect((await enrich(worktree)).observedGitBranch).toBe("second");
    expect(git).toHaveBeenCalledTimes(3);
  });

  it("does not rediscover topology for ordinary edits, commits or sibling worktrees", async () => {
    const enrich = createThreadDirectoryEnricher();
    const first = await enrich(repo);
    git.mockClear();
    await fs.writeFile(path.join(repo, "edited.txt"), "edited\n");
    await fs.mkdir(path.join(repo, ".git", "refs", "heads"), { recursive: true });
    await fs.writeFile(path.join(repo, ".git", "refs", "heads", "main"), "new-commit\n");
    await fs.mkdir(path.join(repo, ".git", "worktrees", "sibling"), { recursive: true });
    expect(await enrich(repo)).toEqual(first);
    expect(git).not.toHaveBeenCalled();
  });

  it("retains unchanged worktree pointer contents across later observations", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const worktree = path.join(root, "worktree");
    const admin = path.join(repo, ".git", "worktrees", "pointer-budget");
    await fs.mkdir(admin, { recursive: true });
    await fs.mkdir(worktree);
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${admin}\n`);
    await fs.writeFile(path.join(admin, "commondir"), "../..\n");
    await fs.writeFile(path.join(admin, "HEAD"), "ref: refs/heads/main\n");
    const enrich = createThreadDirectoryEnricher();
    await enrich(worktree);
    readPointer.mockClear();
    now.mockReturnValue(86_400_000);
    await enrich(worktree);
    expect(readPointer).not.toHaveBeenCalled();
  });

  it("invalidates topology when per-worktree configuration appears", async () => {
    const enrich = createThreadDirectoryEnricher();
    await enrich(repo);
    git.mockClear();
    await fs.writeFile(path.join(repo, ".git", "config.worktree"), "[core]\n bare = false\n");
    await enrich(repo);
    expect(git).toHaveBeenCalledTimes(3);
  });

  it("invalidates a directory symlink when its target changes", async () => {
    const alias = path.join(root, "alias");
    await fs.symlink(repo, alias, "junction");
    const enrich = createThreadDirectoryEnricher();
    await enrich(alias);
    const other = path.join(root, "other");
    await fs.mkdir(path.join(other, ".git"), { recursive: true });
    await fs.writeFile(path.join(other, ".git", "HEAD"), "ref: refs/heads/other\n");
    await fs.rm(alias, { recursive: true });
    await fs.symlink(other, alias, "junction");
    branch = "other";
    expect((await enrich(alias)).observedGitBranch).toBe("other");
  });

  it("does not retain a failed branch refresh", async () => {
    const enrich = createThreadDirectoryEnricher();
    await enrich(repo);
    branch = "after-failure";
    await fs.writeFile(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    fail = true;
    expect((await enrich(repo)).observedGitBranch).toBeUndefined();
    fail = false;
    expect((await enrich(repo)).observedGitBranch).toBe(branch);
  });

  it("does not spawn Git for an unversioned directory and detects git init immediately", async () => {
    const plain = path.join(root, "plain");
    await fs.mkdir(plain);
    const enrich = createThreadDirectoryEnricher();
    expect((await enrich(plain)).linkedDirectories[0]?.kind).toBe("local");
    await enrich(plain);
    expect(git).not.toHaveBeenCalled();
    await fs.mkdir(path.join(plain, ".git"));
    await fs.writeFile(path.join(plain, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect((await enrich(plain)).observedGitBranch).toBe("main");
    expect(git).toHaveBeenCalledTimes(3);
  });

  it("does not publish a cache entry if HEAD changes while Git is running", async () => {
    const enrich = createThreadDirectoryEnricher();
    const invoke = git.getMockImplementation()!;
    let release: () => void = () => {};
    let started: () => void = () => {};
    const probing = new Promise<void>((resolve) => { started = resolve; });
    git.mockImplementationOnce((...args: Parameters<typeof invoke>) => {
      release = () => invoke(...args);
      started();
    });
    const pending = enrich(repo);
    await probing;
    await fs.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/new-head\n");
    release();
    await pending;
    branch = "new-head";
    git.mockClear();
    expect((await enrich(repo)).observedGitBranch).toBe(branch);
    expect(git).toHaveBeenCalledTimes(3);
  });

  it("preserves real Git worktree mappings, branch switches and detached HEAD", async () => {
    const run = await initializeRealGit();
    const worktree = path.join(root, "linked");
    await run(["-C", repo, "worktree", "add", "-b", "feature/fixture", worktree]);
    const enrich = createThreadDirectoryEnricher();
    const first = await enrich(worktree);
    const normalized = (value: string) => value.replace(/\\/g, "/");
    expect(first).toMatchObject({
      observedGitBranch: "feature/fixture",
      linkedDirectories: [{ path: normalized(repo), worktreePath: normalized(worktree), kind: "worktree" }],
    });
    git.mockClear();
    expect(await enrich(worktree)).toEqual(first);
    expect(git).not.toHaveBeenCalled();
    await run(["-C", worktree, "checkout", "-b", "feature/next"]);
    expect((await enrich(worktree)).observedGitBranch).toBe("feature/next");
    expect(git).toHaveBeenCalledTimes(1);
    git.mockClear();
    await run(["-C", worktree, "checkout", "--detach"]);
    expect((await enrich(worktree)).observedGitBranch).toBe("HEAD");
    expect(git).toHaveBeenCalledTimes(1);
  });

  it("discovers the physical repository behind a symlinked subdirectory", async () => {
    await initializeRealGit();
    const subdirectory = path.join(repo, "subdirectory");
    const alias = path.join(root, "alias-to-subdirectory");
    await fs.mkdir(subdirectory);
    await fs.symlink(subdirectory, alias, "junction");
    const enrich = createThreadDirectoryEnricher();
    const first = await enrich(alias);
    expect(first).toMatchObject({
      observedGitBranch: "main",
      linkedDirectories: [{ path: repo.replace(/\\/g, "/"), kind: "local" }],
    });
    git.mockClear();
    expect(await enrich(alias)).toEqual(first);
    expect(git).not.toHaveBeenCalled();
  });

  it.each(["worktree", "common"])("invalidates branch evidence for the %s reftable stack", async (stack) => {
    const worktree = path.join(root, "linked-stack");
    const admin = path.join(repo, ".git", "worktrees", "linked-stack");
    await fs.mkdir(worktree);
    await fs.mkdir(admin, { recursive: true });
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${admin}\n`);
    await fs.writeFile(path.join(admin, "commondir"), "../..\n");
    await fs.writeFile(path.join(admin, "HEAD"), "ref: refs/heads/.invalid\n");
    const tables = path.join(stack === "worktree" ? admin : path.join(repo, ".git"), "reftable");
    await fs.mkdir(tables);
    await fs.writeFile(path.join(tables, "tables.list"), "first.ref\n");
    const enrich = createThreadDirectoryEnricher();
    const first = await enrich(worktree);
    git.mockClear();
    branch = "changed-stack";
    await fs.writeFile(path.join(tables, "tables.list.lock"), "second.ref\n");
    await fs.rename(path.join(tables, "tables.list.lock"), path.join(tables, "tables.list"));
    expect(await enrich(worktree)).toEqual({ ...first, observedGitBranch: branch });
    expect(git).toHaveBeenCalledTimes(1);
  });

  it.for([false, true])("refreshes real reftable branches (linked worktree: %s)", async (linked, context) => {
    const run = await initializeRealGit(["--ref-format=reftable"]).catch((error: unknown) => {
      // Older supported Git releases cannot construct a reftable fixture.
      // Only that explicit capability failure skips this real-Git case.
      if (error instanceof Error && /unknown option.*ref-format/.test(error.message)) {
        context.skip("Installed Git does not support reftable initialization");
      }
      throw error;
    });
    const cwd = linked ? path.join(root, "reftable-linked") : repo;
    if (linked) await run(["-C", repo, "worktree", "add", "-b", "feature/linked", cwd]);
    const enrich = createThreadDirectoryEnricher();
    const first = await enrich(cwd);
    expect(first.observedGitBranch).toBe(linked ? "feature/linked" : "main");
    const headPath = (await run([
      "-C", cwd, "rev-parse", "--path-format=absolute", "--git-path", "HEAD",
    ])).trim();
    const headBefore = await fs.readFile(headPath, "utf8");
    git.mockClear();
    expect(await enrich(cwd)).toEqual(first);
    expect(git).not.toHaveBeenCalled();
    await run(["-C", cwd, "checkout", "-b", "feature/reftable-next"]);
    expect(await fs.readFile(headPath, "utf8")).toBe(headBefore);
    expect(await enrich(cwd)).toEqual({ ...first, observedGitBranch: "feature/reftable-next" });
    expect(git).toHaveBeenCalledTimes(1);
    git.mockClear();
    await run(["-C", cwd, "checkout", "--detach"]);
    expect((await enrich(cwd)).observedGitBranch).toBe("HEAD");
    expect(git).toHaveBeenCalledTimes(1);
    git.mockClear();
    await enrich(cwd);
    expect(git).not.toHaveBeenCalled();
  });
});
