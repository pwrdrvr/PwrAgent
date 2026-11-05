import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
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
// for each checkout. This deliberately uses 200+ worktrees, so its process cost
// exceeds the ordinary single-checkout test timeout, especially on Windows.
it("bounds archive-all Git output independently of the remaining worktree fleet", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-git-fleet-")));
  const count = 201;
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
}, process.platform === "win32" ? 300_000 : 120_000);

// Git owns checkout identity, branch/HEAD and lock state. Generate layouts and
// late mutations at the admission boundary, and compare preservation/removal
// with Git's own registration rather than production's scoped predicate.
it("agrees with Git about archive eligibility across layouts and late registration changes", async () => {
  const layouts = ["ordinary", "linked-anchor", "alias", "bare", "separate"] as const;
  const mutations = ["none", "locked", "late-lock", "late-terminal-lock", "late-backlink", "late-gitfile", "late-common", "late-unregister", "primary", "foreign", "subdirectory"] as const;
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
          if (mutation === "late-backlink") await writeFile(path.join(admin, "gitdir"), `${path.join(repo, ".git")}\n`);
          if (mutation === "late-gitfile") await writeFile(path.join(checkout, ".git"), `gitdir: ${path.join(root, "missing-admin")}\n`);
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
        const reason = mutation === "primary" ? /primary checkout/
          : mutation.includes("lock") ? /locked worktree/ : /registered with Git/;
        await expect(archive).rejects.toThrow(reason);
        expect(await readFile(path.join(checkout, "preserved.txt"), "utf8")).toBe("snapshot me");
        expect(admissionReached).toBe(mutation.startsWith("late-"));
      }
    } finally {
      unregisterTerminals?.();
      await rm(root, { recursive: true, force: true });
    }
  });
  await fc.assert(property, { numRuns: 8, examples: [
    ["ordinary", "none", false], ["linked-anchor", "none", true], ["alias", "none", true],
    ["bare", "none", false], ["separate", "none", true],
    ...mutations.filter((mutation) => mutation !== "none").map((mutation): [typeof layouts[number], typeof mutations[number], boolean] => ["ordinary", mutation, true]),
    ["bare", "primary", true], ["separate", "primary", false],
  ] });
}, process.platform === "win32" ? 120_000 : 30_000);

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
