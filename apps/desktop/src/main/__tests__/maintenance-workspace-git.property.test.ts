import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import * as gitBoundary from "../app-server/git-executable";
import { inspectMaintenanceWorkspace } from "../app-server/thread-maintenance-workspace";
import { HIBERNATION_WORKSPACE_KEEP_REASONS, inspectHibernationWorkspace } from "../app-server/checkout-hibernation-workspace";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { WorktreeRecoveryService } from "../app-server/worktree-recovery-service";
import type { WorktreeSnapshotSummary } from "@pwragent/shared";
import { archiveCoordinatorStandIn } from "./helpers/archive-coordinator-stand-in";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", ["-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false",
    "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-C", cwd, ...args])).stdout.trim();
}

async function fixture(linebreak = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-workspace-git-")));
  const repo = path.join(root, linebreak ? "repo\nwith a newline" : "repo");
  const checkout = path.join(root, "checkout");
  try {
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(path.join(repo, "file.txt"), "original\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "initial");
    await git(repo, "worktree", "add", "-b", "owned", checkout);
    return { root, repo, checkout };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const options = () => ({ signal: new AbortController().signal, limitBytes: 1024 * 1024, rebuildableOutputIsClean: true });
const probe = async (cwd: string) => await inspectHibernationWorkspace(cwd, { ...options(), removeRebuildableOutput: true });

it.each(["nested cwd", "aliased cwd", "aliased nested cwd", "unrelated cwd", "explicit archived restore"] as const)(
  "restores the correct worktree on its saved branch and HEAD with %s (Git oracle)", async (scenario) => {
    const f = await fixture();
    try {
      const identity = { backend: "codex" as const, threadId: "hibernated" };
      const archive = new WorktreeArchiveService();
      const originalHead = await git(f.checkout, "rev-parse", "HEAD");
      const edit = "uncommitted\n";
      await mkdir(path.join(f.checkout, "src"));
      await writeFile(path.join(f.checkout, "src", "untracked.txt"), edit);
      await writeFile(path.join(f.checkout, "file.txt"), edit);
      const alias = `${f.root}-alias`;
      const cwd = scenario.startsWith("aliased")
        ? path.join(alias, "checkout", ...(scenario.includes("nested") ? ["src"] : []))
        : scenario === "nested cwd" ? path.join(f.checkout, "src") : f.repo;
      try {
        if (scenario.startsWith("aliased")) await symlink(f.root, alias, "junction");
        if (scenario !== "explicit archived restore") {
          expect(await realpath(await git(cwd, "rev-parse", "--show-toplevel")))
            .toBe(scenario === "unrelated cwd" ? f.repo : f.checkout);
        }
        let snapshot = await archive.hibernate({ ...identity, repositoryPath: f.repo, worktreePath: f.checkout,
          capSnapshotBytes: 1024 * 1024, beforeRemove: async () => () => {} });
        await expect(stat(f.checkout)).rejects.toMatchObject({ code: "ENOENT" });
        const coordinator = archiveCoordinatorStandIn({
          registry: () => ({
            getCachedThreadSummary: () => undefined,
            resolveThreadEnvironmentCwd: async () => scenario === "explicit archived restore" ? undefined : cwd,
            worktreeArchiveService: archive,
            worktreeRecoveryService: new WorktreeRecoveryService(),
            invalidateThreadListCache: () => {},
            publishLocalEvent: async () => {},
            threadInfoStore: { invalidateSummaries: () => {} },
            threadTurnQueue: { scheduleThreadDrain: () => {} },
          }),
          overlayStore: {
            getThreadOverlayState: async () => ({ ...identity, extraLinkedDirectories: [], worktreeSnapshots: [snapshot] }),
            upsertWorktreeSnapshot: async (record: { snapshot: WorktreeSnapshotSummary }) => { snapshot = record.snapshot; },
          },
        });
        if (scenario === "explicit archived restore") {
          await coordinator.restoreWorktree({ ...identity, worktreePath: snapshot.worktreePath, snapshotRef: snapshot.snapshotRef });
        } else {
          await coordinator.ensureCheckoutAwake(identity);
        }
        if (scenario === "unrelated cwd") {
          expect(snapshot.state).toBe("hibernated");
          await expect(stat(f.checkout)).rejects.toMatchObject({ code: "ENOENT" });
          return;
        }
        expect(snapshot.state).toBe("restored");
        expect(await git(f.checkout, "branch", "--show-current")).toBe("owned");
        expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(originalHead);
        expect(await git(f.checkout, "status", "--porcelain", "--untracked-files=all")).toBe("M file.txt\n?? src/untracked.txt");
        expect(await readFile(path.join(f.checkout, "src", "untracked.txt"), "utf8")).toMatch(/^uncommitted\r?\n$/);
      } finally { await rm(alias, { force: true }); }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  },
);

it("uses one metadata launch per observation, with Git as the layout oracle after branch and cwd changes", async () => {
  const f = await fixture();
  const boundary = vi.spyOn(gitBoundary, "runGitCommand");
  try {
    const nested = path.join(f.checkout, "nested");
    await mkdir(nested);
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (primary, detached, subdirectory) => {
      await git(f.checkout, "checkout", ...(detached ? ["--detach", "main"] : ["owned"]));
      const cwd = primary ? f.repo : subdirectory ? nested : f.checkout;
      const admin = await git(cwd, "rev-parse", "--absolute-git-dir");
      const common = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
      boundary.mockClear();
      expect(await inspectMaintenanceWorkspace(cwd, options())).toEqual({ workspace: {
        kind: path.resolve(admin) === path.resolve(common) ? "inPlace" : "clean",
      } });
      const metadata = boundary.mock.calls.filter(([, args]) => args[0] === "rev-parse" && !args.includes("HEAD"));
      expect(metadata).toHaveLength(1);
    }), { numRuns: 25 });
  } finally {
    boundary.mockRestore();
    await rm(f.root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("preserves newline-bearing Git paths through the separate-query fallback", async () => {
  const f = await fixture(true);
  try {
    expect(await inspectMaintenanceWorkspace(f.repo, options())).toEqual({ workspace: { kind: "inPlace" } });
    expect(await probe(f.checkout)).toEqual({ files: 0, bytes: 0 });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it.each(["bare", "separate"])("keeps %s primary layouts distinct from their linked checkouts", async (layout) => {
  const f = await fixture();
  try {
    const repository = layout === "bare" ? path.join(f.root, "bare.git") : f.repo;
    if (layout === "bare") await git(f.root, "clone", "--bare", f.repo, repository);
    else await git(f.repo, "init", "--separate-git-dir", path.join(f.root, "admin"));
    const linked = path.join(f.root, "linked");
    await git(repository, "worktree", "add", "--detach", linked);
    for (const cwd of [repository, linked]) {
      const admin = await git(cwd, "rev-parse", "--absolute-git-dir");
      const common = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
      expect(await inspectMaintenanceWorkspace(cwd, options())).toEqual({ workspace: {
        kind: path.resolve(admin) === path.resolve(common) ? "inPlace" : "clean",
      } });
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it.each(["edit", "stash", "operation", "head", "branch", "replacement"] as const)(
  "observes %s between review and admission instead of retaining earlier Git facts", async (mutation) => {
    const f = await fixture();
    try {
      if (mutation === "branch") {
        // The stash parent differs from review's HEAD. Only the branch name
        // will identify this stash after admission switches branch and resets.
        await git(f.checkout, "checkout", "-b", "alternate");
        await writeFile(path.join(f.checkout, "file.txt"), "alternate commit\n");
        await git(f.checkout, "commit", "-am", "alternate");
        await writeFile(path.join(f.checkout, "file.txt"), "stashed work\n");
        await git(f.checkout, "stash", "push", "-m", "retained work");
        await git(f.checkout, "checkout", "owned");
      }
      expect(await probe(f.checkout)).toEqual({ files: 0, bytes: 0 });
      if (mutation === "edit") {
        await writeFile(path.join(f.checkout, "file.txt"), "edited\n");
        await writeFile(path.join(f.checkout, "new.txt"), "new\n");
        const sizes = await Promise.all(["file.txt", "new.txt"].map(async (name) => (await stat(path.join(f.checkout, name))).size));
        expect(await probe(f.checkout)).toEqual({ files: 2, bytes: sizes.reduce((a, b) => a + b, 0) });
      } else if (mutation === "stash") {
        await writeFile(path.join(f.checkout, "file.txt"), "stashed work\n");
        await git(f.checkout, "stash", "push", "-m", "retained work");
        expect(await probe(f.checkout)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.stash });
      } else if (mutation === "operation") {
        await git(f.checkout, "bisect", "start");
        expect(await probe(f.checkout)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.operation });
      } else if (mutation === "head") {
        await git(f.checkout, "checkout", "--detach");
        await git(f.checkout, "commit", "--allow-empty", "-m", "unretained");
        expect(await git(f.checkout, "rev-list", "--count", "HEAD", "--not", "--branches", "--remotes")).toBe("1");
        expect(await probe(f.checkout)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.unretained });
      } else if (mutation === "branch") {
        await git(f.checkout, "checkout", "alternate");
        await git(f.checkout, "reset", "--hard", "owned");
        expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(await git(f.repo, "rev-parse", "main"));
        expect(await probe(f.checkout)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.stash });
      } else {
        await git(f.repo, "worktree", "remove", f.checkout);
        await mkdir(f.checkout);
        await git(f.checkout, "init", "-b", "replacement");
        expect(await probe(f.checkout)).toEqual({ keep: HIBERNATION_WORKSPACE_KEEP_REASONS.primary });
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  },
);
