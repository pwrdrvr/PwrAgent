import { execFileSync } from "node:child_process";
import { lstat, open, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { describe, expect, it, vi } from "vitest";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { StackOperationsService } from "../stacks/stack-operations-service";
import { StackReader, StackReadObservation, readStackClones } from "../stacks/stack-reader";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, lstat: vi.fn(fs.lstat), open: vi.fn(fs.open) };
});

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
      const read = async (root: string) => {
        const [physical] = await readStackClones([alias]);
        expect(physical?.root).toBe(await realpath(root));
        const { stacks } = await reader.read(rows, [], [alias]);
        expect(stacks[0]?.layers[0]?.thread?.key).toBe("codex:alias");
        return stacks[0]?.key;
      };
      await symlink(first, alias, "junction");
      const firstKey = await read(first);
      await rm(alias);
      await symlink(second, alias, "junction");
      const secondKey = await read(second);
      expect(secondKey).toBeDefined();
      expect(secondKey).not.toBe(firstKey);
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

  it("uses one checkout and catalog observation for a PR preflight and its projection", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-preflight-"));
    const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      initialize(sandbox);
      await writeCatalog(sandbox, "preflight");
      const reader = new StackReader();
      const rows = [row(sandbox, "preflight")];
      const project = async () => {
        const observation = new StackReadObservation();
        expect((await observation.presentCatalogs([sandbox]))[0]?.status).toBe("ok");
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
