import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import * as gitBoundary from "../app-server/git-executable";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { registerWorktreeTerminalOwner } from "../terminal/worktree-terminals";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false",
    "-C", cwd, ...args,
  ]);
  return stdout.trim();
}

async function repository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "initial");
  return repo;
}

// The Git boundary is measured, not replaced: every snapshot and removal runs
// against the owning Git repository. Archive-all must not read sibling entries
// for each checkout. A small fleet checks this on every platform; the 200+
// measurement runs on POSIX because each real Windows removal owns a separate
// PowerShell Job launcher (0.7-2.1 seconds warm, before the Git work itself).
async function checkArchiveAllGitBudget(count: number): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-git-fleet-")));
  const measurements = { listings: 0, listingLines: 0, outputLines: 0, removals: 0 };
  let boundary: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const repo = await repository(root);
    const checkouts = Array.from({ length: count }, (_, i) => path.join(root, `checkout-${i}`));
    for (const checkout of checkouts) await git(repo, "worktree", "add", "--detach", checkout);
    const runGit = gitBoundary.runGitCommand;
    boundary = vi.spyOn(gitBoundary, "runGitCommand").mockImplementation(async (cwd, args, options) => {
      const result = await runGit(cwd, args, options);
      const lines = result.stdout.split("\n").length - 1;
      measurements.outputLines += lines;
      if (args[0] === "worktree" && args[1] === "list") {
        measurements.listings++;
        measurements.listingLines += lines;
      }
      if (args[0] === "worktree" && args[1] === "remove") measurements.removals++;
      return result;
    });
    const service = new WorktreeArchiveService();
    for (const [i, checkout] of checkouts.entries()) {
      const snapshot = await service.archive({ backend: "codex", threadId: `fleet-${i}`, repositoryPath: repo, worktreePath: checkout });
      expect(snapshot.sourceHead).toMatch(/^[0-9a-f]{40,64}$/);
    }
    boundary.mockRestore();
    expect((await git(repo, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
    expect((await git(repo, "for-each-ref", "--format=%(refname)", "refs/codex/snapshots/")).split("\n")).toHaveLength(count);
    console.info("archive-all Git boundary", { checkouts: count, ...measurements });
    expect(measurements.removals).toBe(count);
    expect(measurements.listings, JSON.stringify(measurements)).toBe(0);
    expect(measurements.listingLines).toBe(0);
    expect(measurements.outputLines).toBeLessThanOrEqual(8 * count);
  } finally {
    boundary?.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}

it("bounds archive-all Git output for a small fleet on every platform", async () => {
  await checkArchiveAllGitBudget(3);
});

it("creates no archive branches or empty-change commits, using Git's tree as the oracle", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.string({ maxLength: 40 }), async (dirty, attached, text) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-clean-archive-git-")));
    try {
      const repo = await repository(root);
      await writeFile(path.join(repo, ".gitignore"), "cache.log\n");
      await git(repo, "add", ".gitignore");
      await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "ignore cache");
      const checkout = path.join(root, "checkout");
      await git(repo, "worktree", "add", ...(attached ? ["-b", "existing-work"] : ["--detach"]), checkout);
      const head = await git(checkout, "rev-parse", "HEAD");
      const branches = await git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
      await writeFile(path.join(checkout, "cache.log"), "ignored content");
      if (dirty) await writeFile(path.join(checkout, "change.txt"), `change ${text}`);
      const snapshot = await new WorktreeArchiveService().archive({ backend: "codex", threadId: "clean-oracle", repositoryPath: repo, worktreePath: checkout });
      expect(await git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/")).toBe(branches);
      if (dirty) {
        expect(snapshot.snapshotCommit).not.toBe(head);
        expect(await git(repo, "show", `${snapshot.snapshotRef}:change.txt`)).toBe(`change ${text}`.trim());
      } else {
        expect(snapshot.snapshotCommit).toBe(head);
        expect(await git(repo, "rev-parse", snapshot.snapshotRef)).toBe(head);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }), { numRuns: process.platform === "win32" ? 4 : 8, examples: [[false, true, ""], [true, false, "bytes"]] });
}, 60_000);

it("serializes deletes by Git common directory while independent repositories proceed together", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-parallel-archive-git-")));
  let boundary: ReturnType<typeof vi.spyOn> | undefined;
  let releasePrepared!: () => void;
  let releaseDeletes!: () => void;
  const allPrepared = new Promise<void>((resolve) => { releasePrepared = resolve; });
  const bothDeleting = new Promise<void>((resolve) => { releaseDeletes = resolve; });
  try {
    const requests: Array<{ repo: string; checkout: string; contents: string }> = [];
    for (let r = 0; r < 2; r += 1) {
      const parent = path.join(root, `repository-${r}`);
      await mkdir(parent);
      const repo = await repository(parent);
      for (let w = 0; w < 2; w += 1) {
        const checkout = path.join(parent, `checkout-${w}`);
        await git(repo, "worktree", "add", "--detach", checkout);
        const contents = `repository ${r}, checkout ${w}`;
        await writeFile(path.join(checkout, "keep.txt"), contents);
        requests.push({ repo, checkout, contents });
      }
    }
    const active = new Map<string, number>();
    const peaks = new Map<string, number>();
    const entered = new Set<string>();
    let globalActive = 0;
    let globalPeak = 0;
    const runGit = gitBoundary.runGitCommand;
    boundary = vi.spyOn(gitBoundary, "runGitCommand").mockImplementation(async (cwd, args, options) => {
      if (args[0] !== "worktree" || args[1] !== "remove") return await runGit(cwd, args, options);
      const repo = await realpath(cwd);
      active.set(repo, (active.get(repo) ?? 0) + 1);
      peaks.set(repo, Math.max(peaks.get(repo) ?? 0, active.get(repo)!));
      globalActive += 1;
      globalPeak = Math.max(globalPeak, globalActive);
      entered.add(repo);
      if (entered.size === 2) releaseDeletes();
      try { await bothDeleting; return await runGit(cwd, args, options); }
      finally { active.set(repo, active.get(repo)! - 1); globalActive -= 1; }
    });
    const service = new WorktreeArchiveService();
    let prepared = 0;
    const snapshots = [];
    for await (const snapshot of new IterableMapper(requests, async (request) => {
      try {
        const snapshot = await service.archive({ backend: "codex", threadId: request.contents, repositoryPath: request.repo, worktreePath: request.checkout,
          beforeRemove: async () => { prepared += 1; if (prepared === requests.length) releasePrepared(); await allPrepared; return () => {}; },
        });
        return { request, snapshot };
      } catch (error) { releasePrepared(); releaseDeletes(); throw error; }
    }, { concurrency: 4, maxUnread: 4, stopOnMapperError: false })) snapshots.push(snapshot);
    expect([...peaks.values()]).toEqual([1, 1]);
    expect(globalPeak).toBe(2);
    // Git is the oracle for completed deletion, retained registrations and
    // every checkout's data in its independently addressed snapshot ref.
    for (const { request, snapshot } of snapshots) {
      expect(await git(request.repo, "show", `${snapshot.snapshotRef}:keep.txt`)).toBe(request.contents);
      expect((await git(request.repo, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
    }
  } finally {
    releasePrepared(); releaseDeletes();
    boundary?.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it.runIf(process.platform !== "win32")("bounds archive-all Git output independently of a 201-checkout fleet", async () => {
  await checkArchiveAllGitBudget(201);
}, 120_000);

// Git owns checkout identity, branch/HEAD and lock state. Generate layouts and
// late mutations at the admission boundary, and compare preservation/removal
// with Git's own registration rather than production's scoped predicate.
it("agrees with Git about archive eligibility across layouts and late registration changes", async () => {
  const layouts = ["ordinary", "linked-anchor", "alias", "bare", "separate"] as const;
  const mutations = ["none", "locked", "late-lock", "late-terminal-lock", "late-backlink", "late-gitfile", "late-common", "late-unregister", "late-head", "primary", "foreign", "subdirectory"] as const;
  let completedRuns = 0;
  const property = fc.asyncProperty(fc.constantFrom(...layouts), fc.constantFrom(...mutations), fc.boolean(), async (layout, mutation, detached) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-git-oracle-")));
    let unregisterTerminals: (() => void) | undefined;
    try {
      let repo = await repository(root);
      if (layout === "bare") {
        await git(root, "clone", "--bare", repo, path.join(root, "bare.git"));
        repo = path.join(root, "bare.git");
      } else if (layout === "separate") {
        await git(repo, "init", "--separate-git-dir", path.join(root, "admin"));
      }
      const checkout = path.join(root, "checkout with spaces");
      await git(repo, "worktree", "add", ...(detached ? ["--detach"] : ["-b", "owned"]), checkout);
      const head = await git(checkout, "rev-parse", "HEAD");
      const admin = await git(checkout, "rev-parse", "--absolute-git-dir");
      let anchor = repo;
      if (layout === "linked-anchor") {
        anchor = path.join(root, "anchor");
        await git(repo, "worktree", "add", "--detach", anchor);
      }
      let target = checkout;
      if (layout === "alias") {
        target = path.join(root, "alias");
        await symlink(checkout, target, process.platform === "win32" ? "junction" : "dir");
      }
      if (mutation === "primary") target = layout === "bare" ? repo : path.join(root, "repo");
      if (mutation === "subdirectory") {
        target = path.join(checkout, "child");
        await mkdir(target);
      }
      if (mutation === "foreign") {
        anchor = path.join(root, "foreign");
        await mkdir(anchor);
        await git(anchor, "init");
      }
      await writeFile(path.join(checkout, "preserved.txt"), "snapshot me");
      if (mutation === "locked") await git(repo, "worktree", "lock", "--reason", "oracle lock", checkout);
      const before = await git(repo, "worktree", "list", "--porcelain");
      expect(before).toContain(checkout.replaceAll("\\", "/"));
      if (mutation === "locked") expect(before).toContain("locked oracle lock");
      if (mutation === "late-terminal-lock") {
        unregisterTerminals = registerWorktreeTerminalOwner({
          async withWorktreeClosed(_worktreePath, work) {
            await git(repo, "worktree", "lock", checkout);
            return await work();
          },
        });
      }
      let admissionReached = false;
      const archive = new WorktreeArchiveService().archive({
        backend: "codex", threadId: "oracle", repositoryPath: anchor, worktreePath: target,
        beforeRemove: async () => {
          admissionReached = true;
          if (mutation === "late-lock") await git(repo, "worktree", "lock", checkout);
          if (mutation === "late-head") await git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "new HEAD");
          if (mutation === "late-backlink") await writeFile(path.join(admin, "gitdir"), `${path.join(repo, ".git")}\n`);
          if (mutation === "late-gitfile") {
            // Git for Windows hides this file; opening a hidden file with
            // writeFile's CREATE_ALWAYS fails with EPERM. Replace the pointer
            // so the fixture reaches the registration check on every OS.
            await rm(path.join(checkout, ".git"), { force: true });
            await writeFile(path.join(checkout, ".git"), `gitdir: ${path.join(root, "missing-admin")}\n`);
          }
          if (mutation === "late-common") await writeFile(path.join(admin, "commondir"), `${root}\n`);
          if (mutation === "late-unregister") await rm(admin, { recursive: true });
          return () => {};
        },
      });
      if (mutation === "none") {
        const snapshot = await archive;
        expect(snapshot.sourceHead).toBe(head);
        expect(snapshot.sourceBranch).toBe(detached ? undefined : "owned");
        expect(await git(snapshot.repositoryPath, "show", `${snapshot.snapshotRef}:preserved.txt`)).toBe("snapshot me");
        expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(checkout.replaceAll("\\", "/"));
        await expect(readFile(path.join(checkout, "preserved.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const reason = mutation === "primary" ? /primary checkout/ : mutation === "late-head" ? /HEAD changed/
          : mutation.includes("lock") ? /locked worktree/ : /registered with Git/;
        await expect(archive).rejects.toThrow(reason);
        expect(await readFile(path.join(checkout, "preserved.txt"), "utf8")).toBe("snapshot me");
        expect(admissionReached).toBe(mutation.startsWith("late-"));
      }
    } finally {
      unregisterTerminals?.();
      await rm(root, { recursive: true, force: true });
    }
    completedRuns++;
  });
  const examples: [typeof layouts[number], typeof mutations[number], boolean][] = [
    ["ordinary", "none", false], ["linked-anchor", "none", true], ["alias", "none", true],
    ["bare", "none", false], ["separate", "none", true],
    ...mutations.filter((mutation) => mutation !== "none").map((mutation): [typeof layouts[number], typeof mutations[number], boolean] => ["ordinary", mutation, true]),
    ["bare", "primary", true], ["separate", "primary", false],
  ];
  await fc.assert(property, { numRuns: examples.length + 24, examples });
  // fast-check includes explicit examples in numRuns. Keep generated coverage
  // after every example, including when the table grows.
  expect(completedRuns).toBe(examples.length + 24);
}, process.platform === "win32" ? 120_000 : 30_000);

async function checkSymlinkLayout(layout: "admin-parent" | "gitfile", lockDuringAdmission: boolean): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-valid-git-link-")));
  try {
    const repo = await repository(root);
    const checkout = path.join(root, "checkout");
    await git(repo, "worktree", "add", "--detach", checkout);
    const admin = await git(checkout, "rev-parse", "--absolute-git-dir");
    if (layout === "admin-parent") {
      const parent = path.join(repo, ".git", "worktrees");
      const moved = path.join(root, "admin-entries");
      await rename(parent, moved);
      await writeFile(path.join(moved, path.basename(admin), "commondir"), `${path.join(repo, ".git")}\n`);
      await symlink(moved, parent, process.platform === "win32" ? "junction" : "dir");
    } else {
      const moved = path.join(root, "gitfile");
      await rename(path.join(checkout, ".git"), moved);
      await symlink(moved, path.join(checkout, ".git"));
    }
    await writeFile(path.join(checkout, "preserved.txt"), "snapshot me");
    // Git recognizes the checkout at its original path in both layouts.
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(`worktree ${checkout.replaceAll("\\", "/")}\n`);
    expect(await git(checkout, "rev-parse", "--show-toplevel")).toBe(checkout.replaceAll("\\", "/"));
    let admissionReached = false;
    const archive = new WorktreeArchiveService().archive({
      backend: "codex", threadId: "valid-link", repositoryPath: repo, worktreePath: checkout,
      beforeRemove: async () => {
        admissionReached = true;
        if (lockDuringAdmission) await git(repo, "worktree", "lock", checkout);
        return () => {};
      },
    });
    if (lockDuringAdmission) {
      await expect(archive).rejects.toThrow(/locked worktree/);
      expect(await readFile(path.join(checkout, "preserved.txt"), "utf8")).toBe("snapshot me");
    } else {
      const snapshot = await archive;
      expect(await git(repo, "show", `${snapshot.snapshotRef}:preserved.txt`)).toBe("snapshot me");
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(checkout.replaceAll("\\", "/"));
    }
    expect(admissionReached).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}

it.each([false, true])("archives a Git-registered symlink admin parent (late lock: %s)", async (lockDuringAdmission) => {
  await checkSymlinkLayout("admin-parent", lockDuringAdmission);
});

it.runIf(process.platform !== "win32").each([false, true])("archives a Git-registered symlink gitfile (late lock: %s)", async (lockDuringAdmission) => {
  await checkSymlinkLayout("gitfile", lockDuringAdmission);
});

it.runIf(process.platform !== "win32")("refuses a Git backlink redirected through a .git file symlink", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-git-link-")));
  try {
    const repo = await repository(root);
    const checkout = path.join(root, "checkout");
    await git(repo, "worktree", "add", "--detach", checkout);
    const admin = await git(checkout, "rev-parse", "--absolute-git-dir");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await rename(path.join(checkout, ".git"), path.join(elsewhere, ".git"));
    await symlink(path.join(elsewhere, ".git"), path.join(checkout, ".git"));
    await writeFile(path.join(admin, "gitdir"), `${path.join(elsewhere, ".git")}\n`);
    await writeFile(path.join(checkout, "preserved.txt"), "keep me");
    // Git now registers elsewhere; resolving both files through the symlink
    // would incorrectly make the original checkout appear registered too.
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(checkout);
    await expect(new WorktreeArchiveService().archive({
      backend: "codex", threadId: "redirected", repositoryPath: repo, worktreePath: checkout,
    })).rejects.toThrow(/not registered with Git/);
    expect(await readFile(path.join(checkout, "preserved.txt"), "utf8")).toBe("keep me");
  } finally { await rm(root, { recursive: true, force: true }); }
});
