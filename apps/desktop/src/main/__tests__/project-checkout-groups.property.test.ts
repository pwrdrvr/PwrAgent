import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import { findPeerCounterpartDirectory } from "@pwragent/shared/federation-project-match";
import { type AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
import { GitDirectoryService } from "../app-server/git-directory-service";
import { runGitCommand } from "../app-server/git-executable";
import { validateProjectCheckoutGroup } from "../app-server/project-checkout-groups";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb } from "./sqlite-test-utils";

it("uses the owner's preferred checkout for new work and leaves Git ownership of existing worktrees intact", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-project-checkouts-");
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = StateDb.open(dbPath);
  try {
    const root = await realpath(tempDir);
    const repoPaths = ["ProjectOld", "ProjectNew", "ProjectSide"].map((name) => canonicalizeNavigationPath(path.join(root, name)));
    const [oldPath, newPath, sidePath] = repoPaths as [string, string, string];
    const oldTree = canonicalizeNavigationPath(path.join(root, "old-worktree"));
    await mkdir(oldPath);
    await runGitCommand(oldPath, ["init"]);
    await runGitCommand(oldPath, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"]);
    await Promise.all([newPath, sidePath].map((checkout) => runGitCommand(root, ["clone", "--no-local", oldPath, checkout])));
    await runGitCommand(oldPath, ["worktree", "add", "--detach", oldTree, "HEAD"]);
    await Promise.all(repoPaths.map((checkout, index) => runGitCommand(checkout, [
      "config", "remote.origin.url", index ? "https://github.com/fixture/project.git" : "git@github.com:fixture/project.git",
    ])));

    const gitCommonDir = async (checkout: string) => canonicalizeNavigationPath(
      (await runGitCommand(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim(),
    );
    const gitOwnership = await Promise.all([oldTree, ...repoPaths].map(gitCommonDir));
    const threads: AppServerThreadSummary[] = repoPaths.map((checkout, index) => ({
      id: `fixture-${index}`, source: "codex", title: `Fixture ${index}`, titleSource: "derived",
      linkedDirectories: [{
        id: checkout, label: path.basename(checkout), path: checkout,
        kind: index === 0 ? "worktree" : "local",
        ...(index === 0 ? { worktreePath: oldTree } : {}),
      }],
    }));
    const store = new SqliteOverlayStore(db);
    const readIndex = () => store.readNavigationQueryIndex({ backend: "all", threads });
    const edit = await validateProjectCheckoutGroup({
      projectPath: oldPath, previousPaths: [], group: { preferredPath: newPath, paths: [oldPath, newPath] },
    });
    expect(edit.group.repositoryKey).toBe("github.com/fixture/project");
    await expect(validateProjectCheckoutGroup({
      projectPath: oldPath, previousPaths: [], group: { preferredPath: oldPath, paths: [oldPath, oldTree] },
    })).rejects.toThrow("primary Git checkout");

    const version = store.readNavigationSourceVersion();
    const { result, writes } = await measureSqliteWrites(() => store.setProjectCheckoutGroup(edit));
    expect(result).toBe(true);
    expectSqliteWriteBudget({
      scenario: "project-checkout-group-save",
      note: "One explicit Project Checkouts save commits once. Ten saves per day cost under 0.1 MB/day.",
      writes,
    });
    expect(store.readNavigationSourceVersion()).not.toBe(version);
    expect(() => store.setProjectCheckoutGroup(edit)).toThrow("checkouts changed");

    const index = readIndex();
    const projects = projectNavigationQuery({
      index, request: { protocol: 2, inventory: "owner", consumer: "agent-tool", query: { kind: "directory-index" } },
    }).directories!;
    const group = projects.find((row) => row.checkoutPaths)!;
    expect(group.path).toBe(newPath);
    expect(group.counts.total).toBe(2);
    expect(projects.find((row) => row.path === sidePath)?.counts.total).toBe(1);
    const peerViewer = {
      kind: "directory" as const, label: "DifferentPeerName", path: "/peer/DifferentPeerName",
      repositoryKey: edit.group.repositoryKey,
    };
    const alternatives = projects.map((row) => ({ ...row, repositoryKey: group.repositoryKey }));
    fc.assert(fc.property(fc.boolean(), (reverse) => {
      const ownerRows = reverse ? [...alternatives].reverse() : alternatives;
      expect(findPeerCounterpartDirectory(peerViewer, ownerRows)?.key).toBe(group.key);
    }));
    const workspaceService = new GitDirectoryService({ homeDir: root });
    const destination = { directoryKind: group.kind, directoryLabel: group.label, directoryPath: group.path };
    const launch = await workspaceService.prepareLaunchpadWorkspace({ ...destination, workMode: "local" });
    expect(launch.cwd).toBe(newPath);
    expect(await gitCommonDir(launch.cwd!)).toBe(gitOwnership[2]);
    const newTree = await workspaceService.prepareLaunchpadWorkspace({
      ...destination, workMode: "worktree", worktreeBranchMode: "detached", worktreeBase: "current_branch",
    });
    expect(newTree.workMode).toBe("worktree");
    expect(await gitCommonDir(newTree.cwd!)).toBe(gitOwnership[2]);
    await newTree.rollback?.();
    expect(await Promise.all([oldTree, ...repoPaths].map(gitCommonDir))).toEqual(gitOwnership);
    expect(index.threads.find((thread) => thread.id === "fixture-0")?.linkedDirectories[0]?.worktreePath).toBe(oldTree);

    expect(store.setProjectCheckoutGroup({
      projectPath: newPath, previousPaths: [oldPath, newPath], group: { preferredPath: oldPath, paths: [oldPath] },
    })).toBe(true);
    expect(readIndex().directories.map((row) => row.path).sort()).toEqual([...repoPaths].sort());
  } finally {
    db.close();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  }
});

it("groups checkouts under the paths their threads use, even through a symlinked parent", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-project-checkouts-link-");
  const db = StateDb.open(dbPath);
  try {
    const root = await realpath(tempDir);
    const realParent = path.join(root, "real");
    const linkedParent = canonicalizeNavigationPath(path.join(root, "linked"));
    await mkdir(realParent);
    await symlink(realParent, linkedParent, "dir");
    const [first, second] = ["ProjectA", "ProjectB"];
    await mkdir(path.join(realParent, first!));
    await runGitCommand(path.join(realParent, first!), ["init"]);
    await runGitCommand(path.join(realParent, first!), ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"]);
    await runGitCommand(realParent, ["clone", "--no-local", first!, second!]);

    // Each checkout is opened either through the symlink or through its real parent.
    const viaParents = fc.tuple(fc.boolean(), fc.boolean());
    await fc.assert(fc.asyncProperty(viaParents, async ([firstLinked, secondLinked]) => {
      const paths = [[first!, firstLinked], [second!, secondLinked]].map(([name, linked]) =>
        canonicalizeNavigationPath(path.join(linked ? linkedParent : realParent, name as string)));
      const threads: AppServerThreadSummary[] = paths.map((checkout, index) => ({
        id: `link-${index}`, source: "codex", title: `Link ${index}`, titleSource: "derived",
        linkedDirectories: [{ id: checkout, label: path.basename(checkout), path: checkout, kind: "local" }],
      }));
      const store = new SqliteOverlayStore(db);
      const edit = await validateProjectCheckoutGroup({
        projectPath: paths[0]!, previousPaths: [], group: { preferredPath: paths[1]!, paths },
      });
      expect(edit.group.paths).toEqual(paths);
      expect(edit.group.preferredPath).toBe(paths[1]);
      expect(store.setProjectCheckoutGroup(edit)).toBe(true);
      const directories = store.readNavigationQueryIndex({ backend: "all", threads }).directories;
      expect(directories.map((directory) => directory.path)).toEqual([paths[1]]);
      expect(directories[0]!.threadKeys).toHaveLength(2);
      store.setProjectCheckoutGroup({
        projectPath: paths[1]!, previousPaths: paths, group: { preferredPath: paths[1]!, paths: [paths[1]!] },
      });
    }), { numRuns: 8 });
  } finally {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

it("reads navigation past any stored checkout-group payload and keeps only well-formed groups", () => {
  const good = { preferredPath: "/fixture/preferred", paths: ["/fixture/old", "/fixture/preferred"] };
  const payloads = fc.oneof(
    fc.string(),
    fc.json(),
    fc.constant("[null,1,\"x\",{\"paths\":7}]"),
    fc.constant(JSON.stringify([good, { preferredPath: 3, paths: [] }])),
  );
  fc.assert(fc.property(payloads, (payload) => {
    const db = openInMemoryStateDb();
    try {
      db.setMeta("project-checkout-groups", payload);
      const store = new SqliteOverlayStore(db);
      const directories = store.readNavigationQueryIndex({ backend: "all", threads: [] }).directories;
      for (const directory of directories) {
        expect(directory.checkoutPaths?.every((path) => typeof path === "string") ?? true).toBe(true);
      }
      if (payload === JSON.stringify([good, { preferredPath: 3, paths: [] }])) {
        expect(directories.map((directory) => directory.path)).toEqual([good.preferredPath]);
      }
    } finally {
      db.close();
    }
  }), { numRuns: 60 });
});

it("keeps the last accepted grouping through preference changes, splits and stale edits", () => {
  const paths = ["/fixture/old", "/fixture/preferred"];
  const edits = fc.array(fc.constantFrom("group", "switch", "split", "stale"), { minLength: 1, maxLength: 30 });
  fc.assert(fc.property(edits, (sequence) => {
    const db = openInMemoryStateDb();
    try {
      const store = new SqliteOverlayStore(db);
      let preferredPath: string | undefined;
      for (const edit of sequence) {
        const projectPath = preferredPath ?? paths[0]!;
        const previousPaths = preferredPath ? paths : [];
        const otherPath = paths.find((path) => path !== projectPath)!;
        if (edit === "stale") {
          expect(() => store.setProjectCheckoutGroup({
            projectPath, previousPaths: preferredPath ? [] : paths,
            group: { preferredPath: projectPath, paths },
          })).toThrow("checkouts changed");
        } else {
          const nextPreferred = edit === "split" ? undefined : edit === "switch" ? otherPath : projectPath;
          const changed = store.setProjectCheckoutGroup({
            projectPath, previousPaths,
            group: { preferredPath: nextPreferred ?? projectPath, paths: nextPreferred ? paths : [projectPath] },
          });
          expect(changed).toBe(nextPreferred !== preferredPath);
          preferredPath = nextPreferred;
        }
        const index = store.readNavigationQueryIndex({ backend: "all", threads: [] });
        expect(index.directories.map((directory) => directory.path)).toEqual(preferredPath ? [preferredPath] : []);
      }
    } finally {
      db.close();
    }
  }), { numRuns: 25 });
});
