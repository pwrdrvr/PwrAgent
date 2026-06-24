import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  GitWorkingStateService,
  probeWorktreeWorkingState,
} from "../app-server/git-working-state-service";

type GitCall = { cwd: string; args: string[] };

function makeTempPrefix(): string {
  return path.join(os.tmpdir(), "pwragent-git-working-state-");
}

function normalizeTestPath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

function fakeGit(
  responder: (args: string[]) => string | undefined,
): { runGit: (cwd: string, args: string[]) => Promise<string>; calls: GitCall[] } {
  const calls: GitCall[] = [];
  const runGit = async (cwd: string, args: string[]): Promise<string> => {
    calls.push({ cwd, args });
    const result = responder(args);
    if (result === undefined) {
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    }
    return result;
  };
  return { runGit, calls };
}

function respondWorkingState(args: string[]): string | undefined {
  if (args.includes("--numstat")) {
    // A binary file ("-\t-") counts as a dirty file with no line totals.
    return "3\t1\tsrc/a.ts\n-\t-\tassets/logo.png\n";
  }
  if (args.includes("status")) {
    return " M src/a.ts\n?? scratch/new.txt\n?? scratch/other.txt\n";
  }
  if (args[args.length - 1] === "remote") {
    return "origin\n";
  }
  if (args.includes("rev-list")) {
    return "4\n";
  }
  return undefined;
}

describe("probeWorktreeWorkingState", () => {
  it("parses dirty, untracked, and unpushed counts and passes --no-optional-locks", async () => {
    const { runGit, calls } = fakeGit(respondWorkingState);

    const state = await probeWorktreeWorkingState("/repo/wt", { runGit });

    expect(state).toEqual({
      dirtyFiles: 4,
      dirtyAdditions: 3,
      dirtyDeletions: 1,
      untrackedFiles: 2,
      unpushedCommits: 4,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.cwd).toBe("/repo/wt");
      expect(call.args[0]).toBe("--no-optional-locks");
    }
  });

  it("reports zero unpushed commits and skips rev-list when no remotes exist", async () => {
    const { runGit, calls } = fakeGit((args) => {
      if (args.includes("--numstat")) return "";
      if (args.includes("status")) return "";
      if (args[args.length - 1] === "remote") return "";
      if (args.includes("rev-list")) return "9\n";
      return undefined;
    });

    const state = await probeWorktreeWorkingState("/repo/wt", { runGit });

    expect(state).toEqual({
      dirtyFiles: 0,
      dirtyAdditions: 0,
      dirtyDeletions: 0,
      untrackedFiles: 0,
      unpushedCommits: 0,
    });
    expect(calls.some((call) => call.args.includes("rev-list"))).toBe(false);
  });

  it("does not count commits attached to merged PRs as unpushed", async () => {
    const mergedPrSha = "a".repeat(40);
    const localOnlySha = "b".repeat(40);
    const { runGit } = fakeGit((args) => {
      if (args.includes("--numstat")) return "";
      if (args.includes("status")) return "";
      if (args[args.length - 1] === "remote") return "origin\n";
      if (args.includes("rev-list") && args.includes("--count")) return "2\n";
      if (args.includes("rev-list")) return `${mergedPrSha}\n${localOnlySha}\n`;
      return undefined;
    });

    const state = await probeWorktreeWorkingState("/repo/wt", {
      runGit,
      acceptedPushedCommitShas: [mergedPrSha],
    });

    expect(state?.unpushedCommits).toBe(1);
  });

  it("infers the likely base branch and behind-base count from git refs", async () => {
    const headCommit = "a".repeat(40);
    const mainTip = "b".repeat(40);
    const mainBase = "c".repeat(40);
    const releaseTip = "d".repeat(40);
    const releaseBase = "e".repeat(40);
    const { runGit } = fakeGit((args) => {
      if (args.includes("--numstat")) return "";
      if (args.includes("status")) return "";
      if (args[args.length - 1] === "remote") return "origin\n";
      if (args.includes("rev-parse") && args.includes("--verify")) {
        const target = args[args.length - 1];
        if (target === "HEAD^{commit}") return `${headCommit}\n`;
        if (target === "origin/main^{commit}") return `${mainTip}\n`;
        if (target === "main^{commit}") return `${mainTip}\n`;
        if (target === "releases/4.3^{commit}") return `${releaseTip}\n`;
        if (target === "origin/releases/4.3^{commit}") return `${releaseTip}\n`;
      }
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        return "feature/work\n";
      }
      if (args.includes("config")) return "";
      if (args.includes("symbolic-ref")) return "origin/main\n";
      if (args.includes("for-each-ref")) {
        return [
          "main",
          "releases/4.3",
          "feature/work",
          "origin/main",
          "origin/releases/4.3",
        ].join("\n");
      }
      if (args.includes("merge-base")) {
        const target = args[args.length - 1];
        if (target === "origin/main" || target === "main") return `${mainBase}\n`;
        if (target === "releases/4.3" || target === "origin/releases/4.3") {
          return `${releaseBase}\n`;
        }
      }
      if (args.includes("rev-list") && args.includes("--count")) {
        const range = args[args.length - 1];
        if (range === "HEAD") return "0\n";
        if (range === `${mainBase}..origin/main` || range === `${mainBase}..main`) {
          return "7\n";
        }
        if (range === `${mainBase}..HEAD`) return "30\n";
        if (
          range === `${releaseBase}..releases/4.3` ||
          range === `${releaseBase}..origin/releases/4.3`
        ) {
          return "2\n";
        }
        if (range === `${releaseBase}..HEAD`) return "5\n";
      }
      return undefined;
    });

    const state = await probeWorktreeWorkingState("/repo/wt", { runGit });

    expect(state).toMatchObject({
      baseBranch: "releases/4.3",
      baseCommit: releaseBase,
      baseTipCommit: releaseTip,
      baseBehindCommitCount: 2,
      baseAheadCommitCount: 5,
      isBehindBase: true,
    });
  });

  it("keeps base metadata when detached HEAD is exactly at the base tip", async () => {
    const baseTip = "f".repeat(40);
    const { runGit } = fakeGit((args) => {
      if (args.includes("--numstat")) return "";
      if (args.includes("status")) return "";
      if (args[args.length - 1] === "remote") return "";
      if (args.includes("rev-parse") && args.includes("--verify")) {
        const target = args[args.length - 1];
        if (target === "HEAD^{commit}") return `${baseTip}\n`;
        if (target === "main^{commit}") return `${baseTip}\n`;
      }
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        return "HEAD\n";
      }
      if (args.includes("symbolic-ref")) return "";
      if (args.includes("for-each-ref")) return "main\n";
      if (args.includes("merge-base")) return `${baseTip}\n`;
      if (args.includes("rev-list") && args.includes("--count")) return "0\n";
      return undefined;
    });

    const state = await probeWorktreeWorkingState("/repo/wt", { runGit });

    expect(state).toMatchObject({
      baseBranch: "main",
      baseCommit: baseTip,
      baseTipCommit: baseTip,
      baseBehindCommitCount: 0,
      baseAheadCommitCount: 0,
      isBehindBase: false,
    });
  });

  it("returns undefined when the directory is not a git checkout", async () => {
    const { runGit } = fakeGit(() => undefined);
    expect(await probeWorktreeWorkingState("/not/a/repo", { runGit })).toBeUndefined();
  });

  it("includes cheap untracked text additions in the dirty working-state totals", async () => {
    const tmpRoot = await mkdtemp(makeTempPrefix());
    try {
      await writeFile(path.join(tmpRoot, "note.txt"), "alpha\nbeta\n", "utf8");
      await writeFile(path.join(tmpRoot, "archive.zip"), Buffer.from([0, 1, 2, 3]));
      const { runGit } = fakeGit((args) => {
        if (args.includes("--numstat")) return "3\t1\tsrc/a.ts\n";
        if (args.includes("status")) {
          return " M src/a.ts\0?? note.txt\0?? archive.zip\0?? scratch/\0";
        }
        if (args[args.length - 1] === "remote") return "";
        return undefined;
      });

      const state = await probeWorktreeWorkingState(tmpRoot, { runGit });

      expect(state).toEqual({
        dirtyFiles: 4,
        dirtyAdditions: 5,
        dirtyDeletions: 1,
        untrackedFiles: 3,
        unpushedCommits: 0,
      });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("GitWorkingStateService", () => {
  it("coalesces concurrent probes of the same worktree into one git run", async () => {
    const responder = vi.fn(respondWorkingState);
    const { runGit } = fakeGit(responder);
    const service = new GitWorkingStateService({ runGit });

    const [a, b] = await Promise.all([
      service.readWorkingState("/repo/wt"),
      service.readWorkingState("/repo/wt"),
    ]);

    expect(a).toEqual(b);
    // numstat + status + remote + base HEAD probe + rev-list = 5 git calls for ONE probe.
    expect(responder).toHaveBeenCalledTimes(5);
  });

  it("serves a fresh cache entry without re-probing, and re-probes after invalidate", async () => {
    const responder = vi.fn(respondWorkingState);
    const { runGit } = fakeGit(responder);
    const service = new GitWorkingStateService({ runGit, cacheTtlMs: 60_000 });

    await service.readWorkingState("/repo/wt");
    expect(responder).toHaveBeenCalledTimes(5);

    await service.readWorkingState("/repo/wt");
    expect(responder).toHaveBeenCalledTimes(5); // cached

    service.invalidate("/repo/wt");
    await service.readWorkingState("/repo/wt");
    expect(responder).toHaveBeenCalledTimes(10); // re-probed
  });

  it("streams entries for many worktrees", async () => {
    const { runGit } = fakeGit(respondWorkingState);
    const service = new GitWorkingStateService({ runGit });

    const seen = new Map<string, unknown>();
    for await (const entry of service.readWorkingStateEntries([
      "/repo/one",
      "/repo/two",
    ])) {
      seen.set(entry.worktreePath, entry.gitWorkingState);
    }

    expect([...seen.keys()].sort()).toEqual(["/repo/one", "/repo/two"]);
    expect(seen.get("/repo/one")).toMatchObject({ dirtyFiles: 4 });
  });

  it("lists other worktree changes with excluded turn paths filtered before the cap", async () => {
    const worktreePath = "/repo/wt";
    const { runGit } = fakeGit((args) => {
      if (args.includes("status")) {
        return [
          " M src/turn.ts",
          " M docs/PwrAgnt v2.html",
          "A  src/other-b.ts",
          "?? scratch/",
          "",
        ].join("\0");
      }
      if (args.includes("--numstat")) {
        return "2\t1\tdocs/PwrAgnt v2.html\n4\t0\tsrc/other-b.ts\n";
      }
      if (args.includes("ls-files")) {
        return "scratch/new.txt\0";
      }
      return undefined;
    });
    const service = new GitWorkingStateService({ runGit });

    const response = await service.listOtherChanges(worktreePath, {
      excludePaths: [`${worktreePath}/src/turn.ts`],
      maxFiles: 2,
    });

    expect(response).toEqual({
      changes: [
        {
          path: normalizeTestPath(`${worktreePath}/docs/PwrAgnt v2.html`),
          repoPath: "docs/PwrAgnt v2.html",
          status: "modified",
          staged: false,
          unstaged: true,
          additions: 2,
          removals: 1,
        },
        {
          path: normalizeTestPath(`${worktreePath}/src/other-b.ts`),
          repoPath: "src/other-b.ts",
          status: "added",
          staged: true,
          unstaged: false,
          additions: 4,
          removals: 0,
        },
      ],
      totalChanges: 3,
      truncated: true,
      maxFiles: 2,
    });
  });

  it("expands collapsed untracked directories without an unbounded status scan", async () => {
    const worktreePath = "/repo/wt";
    const { runGit, calls } = fakeGit((args) => {
      if (args.includes("status")) {
        return "?? .tmp/\0";
      }
      if (args.includes("ls-files")) {
        return ".tmp/monitors/run/stdout.log\0.tmp/monitors/run/stderr.log\0";
      }
      if (args.includes("--numstat")) return "";
      return undefined;
    });
    const service = new GitWorkingStateService({ runGit });

    const response = await service.listOtherChanges(worktreePath);

    expect(
      calls.some(
        (call) =>
          call.args.includes("status") &&
          call.args.includes("--untracked-files=normal"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.args.includes("ls-files"))).toBe(true);
    expect(response.changes).toEqual([
      {
        path: normalizeTestPath(`${worktreePath}/.tmp/monitors/run/stdout.log`),
        repoPath: ".tmp/monitors/run/stdout.log",
        status: "untracked",
        staged: false,
        unstaged: true,
      },
      {
        path: normalizeTestPath(`${worktreePath}/.tmp/monitors/run/stderr.log`),
        repoPath: ".tmp/monitors/run/stderr.log",
        status: "untracked",
        staged: false,
        unstaged: true,
      },
    ]);
  });

  it("caps expansion of large untracked directory trees", async () => {
    const worktreePath = "/repo/wt";
    const { runGit } = fakeGit((args) => {
      if (args.includes("status")) return "?? node_modules/\0";
      if (args.includes("ls-files")) {
        return [
          "node_modules/a.js",
          "node_modules/b.js",
          "node_modules/c.js",
          "node_modules/d.js",
        ].join("\0");
      }
      if (args.includes("--numstat")) return "";
      return undefined;
    });
    const service = new GitWorkingStateService({ runGit });

    const response = await service.listOtherChanges(worktreePath, { maxFiles: 2 });

    expect(response.changes).toEqual([
      {
        path: normalizeTestPath(`${worktreePath}/node_modules/a.js`),
        repoPath: "node_modules/a.js",
        status: "untracked",
        staged: false,
        unstaged: true,
      },
      {
        path: normalizeTestPath(`${worktreePath}/node_modules/b.js`),
        repoPath: "node_modules/b.js",
        status: "untracked",
        staged: false,
        unstaged: true,
      },
    ]);
    expect(response.totalChanges).toBe(3);
    expect(response.truncated).toBe(true);
  });

  it("does not let excluded files consume the untracked directory expansion cap", async () => {
    const worktreePath = "/repo/wt";
    const { runGit } = fakeGit((args) => {
      if (args.includes("status")) return "?? scratch/\0";
      if (args.includes("ls-files")) {
        return [
          "scratch/turn-a.txt",
          "scratch/turn-b.txt",
          "scratch/other.txt",
        ].join("\0");
      }
      if (args.includes("--numstat")) return "";
      return undefined;
    });
    const service = new GitWorkingStateService({ runGit });

    const response = await service.listOtherChanges(worktreePath, {
      excludePaths: [
        `${worktreePath}/scratch/turn-a.txt`,
        `${worktreePath}/scratch/turn-b.txt`,
      ],
      maxFiles: 1,
    });

    expect(response.changes).toEqual([
      {
        path: normalizeTestPath(`${worktreePath}/scratch/other.txt`),
        repoPath: "scratch/other.txt",
        status: "untracked",
        staged: false,
        unstaged: true,
      },
    ]);
    expect(response.totalChanges).toBe(1);
    expect(response.truncated).toBe(false);
  });

  it("caps displayed changes from any single top-level directory", async () => {
    const worktreePath = "/repo/wt";
    const { runGit } = fakeGit((args) => {
      if (args.includes("status")) return "?? node_modules/\0?? src/readme.md\0";
      if (args.includes("ls-files")) {
        return Array.from(
          { length: 25 },
          (_, index) => `node_modules/pkg-${index}.js`,
        ).join("\0");
      }
      if (args.includes("--numstat")) return "";
      return undefined;
    });
    const service = new GitWorkingStateService({ runGit });

    const response = await service.listOtherChanges(worktreePath);

    expect(
      response.changes.filter((change) =>
        change.repoPath.startsWith("node_modules/"),
      ),
    ).toHaveLength(20);
    expect(response.changes.at(-1)).toMatchObject({
      repoPath: "src/readme.md",
      status: "untracked",
    });
    expect(response.totalChanges).toBe(22);
    expect(response.truncated).toBe(true);
  });

  it("recovers unstaged status records after git stdout trimming", async () => {
    const { runGit } = fakeGit((args) => {
      if (args.includes("status")) {
        return "M apps/desktop/src/main/__tests__/git-working-state-service.test.ts\0";
      }
      if (args.includes("--numstat")) {
        return "";
      }
      return undefined;
    });
    const service = new GitWorkingStateService({ runGit });

    const response = await service.listOtherChanges("/repo/wt", {
      excludePaths: [
        "/repo/wt/apps/desktop/src/main/__tests__/git-working-state-service.test.ts",
      ],
    });

    expect(response.changes).toEqual([]);
    expect(response.totalChanges).toBe(0);
  });

  it("reports added-line totals for small untracked text files and byte sizes for binary files", async () => {
    const tmpRoot = await mkdtemp(makeTempPrefix());
    try {
      await writeFile(path.join(tmpRoot, "note.txt"), "alpha\nbeta\n", "utf8");
      await writeFile(path.join(tmpRoot, "archive.zip"), Buffer.from([0, 1, 2, 3]));
      const { runGit } = fakeGit((args) => {
        if (args.includes("status")) return "?? note.txt\0?? archive.zip\0";
        if (args.includes("--numstat")) return "";
        return undefined;
      });
      const service = new GitWorkingStateService({ runGit });

      const response = await service.listOtherChanges(tmpRoot);

      expect(response.changes).toEqual([
        {
          path: normalizeTestPath(path.join(tmpRoot, "note.txt")),
          repoPath: "note.txt",
          status: "untracked",
          staged: false,
          unstaged: true,
          sizeBytes: 11,
          additions: 2,
          removals: 0,
        },
        {
          path: normalizeTestPath(path.join(tmpRoot, "archive.zip")),
          repoPath: "archive.zip",
          status: "untracked",
          staged: false,
          unstaged: true,
          binary: true,
          sizeBytes: 4,
        },
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("does not report line totals for tracked binary changes", async () => {
    const tmpRoot = await mkdtemp(makeTempPrefix());
    try {
      await writeFile(path.join(tmpRoot, "asset.png"), Buffer.from([0, 1, 2]));
      const { runGit } = fakeGit((args) => {
        if (args.includes("status")) return " M asset.png\0";
        if (args.includes("--numstat")) return "-\t-\tasset.png\n";
        return undefined;
      });
      const service = new GitWorkingStateService({ runGit });

      const response = await service.listOtherChanges(tmpRoot);

      expect(response.changes).toEqual([
        {
          path: normalizeTestPath(path.join(tmpRoot, "asset.png")),
          repoPath: "asset.png",
          status: "modified",
          staged: false,
          unstaged: true,
          binary: true,
          sizeBytes: 3,
        },
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("builds a single-file diff on demand for an untracked file", async () => {
    const tmpRoot = await mkdtemp(makeTempPrefix());
    const filePath = path.join(tmpRoot, "note.txt");
    await writeFile(filePath, "hello\nworld\n", "utf8");
    const { runGit } = fakeGit((args) => {
      if (args.includes("status")) return "?? note.txt";
      return undefined;
    });
    const service = new GitWorkingStateService({ runGit });

    try {
      const response = await service.getOtherChangeDiff(tmpRoot, filePath);

      expect(response.detail?.fileDiff).toMatchObject({
        kind: "add",
        additions: 2,
        removals: 0,
      });
      expect(response.detail?.fileDiff?.diff).toContain("+++ b/note.txt");
      expect(response.detail?.fileDiff?.diff).toContain("+hello");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("does not build an edited-file detail for an untracked directory", async () => {
    const tmpRoot = await mkdtemp(makeTempPrefix());
    const dirPath = path.join(tmpRoot, ".tmp");
    await mkdir(dirPath);
    const { runGit } = fakeGit((args) => {
      if (args.includes("status")) return "?? .tmp/";
      return undefined;
    });
    const service = new GitWorkingStateService({ runGit });

    try {
      const response = await service.getOtherChangeDiff(tmpRoot, dirPath);

      expect(response.detail).toBeUndefined();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("GitWorkingStateService.resolveEditCommitStates", () => {
  function respondCommitStates(args: string[]): string | undefined {
    if (args.includes("diff") && args.includes("--name-only")) {
      return "src/a.ts\n"; // a.ts still has uncommitted changes
    }
    if (args.includes("ls-files")) {
      return ""; // nothing untracked
    }
    if (args.includes("log")) {
      const paths = args.slice(args.indexOf("--") + 1);
      if (paths.some((p) => p.endsWith("/src/b.ts"))) return `${"b".repeat(40)}\n`;
      if (paths.some((p) => p.endsWith("/src/c.ts"))) return `${"c".repeat(40)}\n`;
      return "";
    }
    if (args.includes("rev-list")) {
      const sha = args[args.indexOf("rev-list") + 2];
      // c-commit is local-only (rev-list returns it); b-commit is pushed (empty).
      return sha?.startsWith("c") ? sha : "";
    }
    return undefined;
  }

  it("classifies groups as uncommitted vs committed with sha + push state", async () => {
    const { runGit, calls } = fakeGit(respondCommitStates);
    const service = new GitWorkingStateService({ runGit });

    const states = await service.resolveEditCommitStates("/repo/wt", [
      { key: "g-a", paths: ["/repo/wt/src/a.ts"] },
      { key: "g-b", paths: ["/repo/wt/src/b.ts"] },
      { key: "g-c", paths: ["/repo/wt/src/c.ts"] },
      // Not dirty (git ignores it) and no commit in history — e.g. a
      // `.gitignore`'d PR.md the agent wrote. Must NOT be "committed".
      { key: "g-ignored", paths: ["/repo/wt/PR.md"] },
    ]);

    expect(states["g-a"]).toEqual({ committed: false });
    expect(states["g-b"]).toEqual({
      committed: true,
      commitSha: "b".repeat(40),
      shortSha: "bbbbbbb",
      pushed: true,
    });
    expect(states["g-c"]).toEqual({
      committed: true,
      commitSha: "c".repeat(40),
      shortSha: "ccccccc",
      pushed: false,
    });
    expect(states["g-ignored"]).toEqual({ committed: false });
    // Every probe is lock-safe.
    for (const call of calls) {
      expect(call.args[0]).toBe("--no-optional-locks");
    }
  });

  it("flags gitignored paths and excludes them from the committed judgement", async () => {
    const responder = (args: string[]): string | undefined => {
      if (args.includes("diff") && args.includes("--name-only")) return "";
      if (args.includes("ls-files")) return "";
      if (args.includes("check-ignore")) {
        // Report the relative inputs ending in PR.md as ignored.
        const inputs = args.slice(args.indexOf("--") + 1);
        return inputs.filter((value) => value.endsWith("PR.md")).join("\n");
      }
      if (args.includes("log")) {
        const paths = args.slice(args.indexOf("--") + 1);
        return paths.some((p) => p.endsWith("src/b.ts"))
          ? `${"b".repeat(40)}\n`
          : "";
      }
      if (args.includes("rev-list")) return ""; // pushed
      return undefined;
    };
    const { runGit, calls } = fakeGit(responder);
    const service = new GitWorkingStateService({ runGit });

    const states = await service.resolveEditCommitStates("/repo/wt", [
      // Mixed: a committed tracked file alongside a gitignored one. The group
      // still reads committed/pushed from the tracked file, but the ignored
      // file is surfaced separately rather than implied committed.
      { key: "g-mixed", paths: ["/repo/wt/src/b.ts", "/repo/wt/PR.md"] },
      // All-ignored: no tracked files ⇒ not committed, but flagged ignored.
      { key: "g-ignored", paths: ["/repo/wt/PR.md"] },
    ]);

    expect(states["g-mixed"]).toEqual({
      committed: true,
      commitSha: "b".repeat(40),
      shortSha: "bbbbbbb",
      pushed: true,
      ignoredPaths: ["/repo/wt/PR.md"],
    });
    expect(states["g-ignored"]).toEqual({
      committed: false,
      ignoredPaths: ["/repo/wt/PR.md"],
    });
    // The ignored set is resolved once over the union, lock-safe.
    expect(
      calls.filter((call) => call.args.includes("check-ignore")),
    ).toHaveLength(1);
    for (const call of calls) {
      expect(call.args[0]).toBe("--no-optional-locks");
    }
  });

  it("runs the remote-reachability check once per unique commit", async () => {
    const { runGit, calls } = fakeGit(respondCommitStates);
    const service = new GitWorkingStateService({ runGit });

    // Two groups resolving to the same commit must share one `rev-list`.
    const states = await service.resolveEditCommitStates("/repo/wt", [
      { key: "g-b", paths: ["/repo/wt/src/b.ts"] },
      { key: "g-b2", paths: ["/repo/wt/src/b.ts"] },
    ]);

    expect(states["g-b"]).toMatchObject({ committed: true, pushed: true });
    expect(states["g-b2"]).toMatchObject({ committed: true, pushed: true });
    expect(calls.filter((call) => call.args.includes("rev-list"))).toHaveLength(1);
  });

  it("treats commits attached to merged PRs as pushed even when no remote ref contains them", async () => {
    const mergedPrSha = "d".repeat(40);
    const responder = (args: string[]): string | undefined => {
      if (args.includes("diff") && args.includes("--name-only")) return "";
      if (args.includes("ls-files")) return "";
      if (args.includes("check-ignore")) return "";
      if (args.includes("log")) return `${mergedPrSha}\n`;
      if (args.includes("rev-list")) return `${mergedPrSha}\n`;
      return undefined;
    };
    const { runGit } = fakeGit(responder);
    const service = new GitWorkingStateService({ runGit });

    const states = await service.resolveEditCommitStates(
      "/repo/wt",
      [{ key: "g-merged", paths: ["/repo/wt/src/merged.ts"] }],
      { acceptedPushedCommitShas: [mergedPrSha] },
    );

    expect(states["g-merged"]).toMatchObject({
      committed: true,
      commitSha: mergedPrSha,
      pushed: true,
    });
  });

  it("returns an empty map for no worktree or no groups", async () => {
    const { runGit, calls } = fakeGit(respondCommitStates);
    const service = new GitWorkingStateService({ runGit });

    expect(await service.resolveEditCommitStates("", [{ key: "g", paths: ["/x"] }])).toEqual({});
    expect(await service.resolveEditCommitStates("/repo/wt", [])).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
