import { describe, expect, it, vi } from "vitest";
import {
  GitWorkingStateService,
  probeWorktreeWorkingState,
} from "../app-server/git-working-state-service";

type GitCall = { cwd: string; args: string[] };

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
      dirtyFiles: 2,
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

  it("returns undefined when the directory is not a git checkout", async () => {
    const { runGit } = fakeGit(() => undefined);
    expect(await probeWorktreeWorkingState("/not/a/repo", { runGit })).toBeUndefined();
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
    // numstat + status + remote + rev-list = 4 git calls for ONE probe.
    expect(responder).toHaveBeenCalledTimes(4);
  });

  it("serves a fresh cache entry without re-probing, and re-probes after invalidate", async () => {
    const responder = vi.fn(respondWorkingState);
    const { runGit } = fakeGit(responder);
    const service = new GitWorkingStateService({ runGit, cacheTtlMs: 60_000 });

    await service.readWorkingState("/repo/wt");
    expect(responder).toHaveBeenCalledTimes(4);

    await service.readWorkingState("/repo/wt");
    expect(responder).toHaveBeenCalledTimes(4); // cached

    service.invalidate("/repo/wt");
    await service.readWorkingState("/repo/wt");
    expect(responder).toHaveBeenCalledTimes(8); // re-probed
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
    expect(seen.get("/repo/one")).toMatchObject({ dirtyFiles: 2 });
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

  it("returns an empty map for no worktree or no groups", async () => {
    const { runGit, calls } = fakeGit(respondCommitStates);
    const service = new GitWorkingStateService({ runGit });

    expect(await service.resolveEditCommitStates("", [{ key: "g", paths: ["/x"] }])).toEqual({});
    expect(await service.resolveEditCommitStates("/repo/wt", [])).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
