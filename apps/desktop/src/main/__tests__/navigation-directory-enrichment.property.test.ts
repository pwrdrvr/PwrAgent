import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { loadLocalNavigationQueryIndex } from "../app-server/navigation-query-source";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { createThreadDirectoryEnricher, readNavigationCheckoutDirectory } from "../git-info/directory-store";

vi.mock("../app-server/backend-registry", () => ({}));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
vi.mock("../messaging/desktop-messaging-store", () => ({
  getDesktopMessagingStore: () => ({ findActiveBindings: async () => [] }),
}));
vi.mock("../storage/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({
    readNavigationQueryIndex: ({ threads }: { threads: AppServerThreadSummary[] }) => ({
      threads: threads.map((thread) => ({ ...thread, inbox: { inInbox: false } })),
      directories: [],
    }),
    readDirectoryGitStatusCache: async () => ({}),
    listAllActivePrStatusWatches: async () => [],
  }),
}));

const normalize = (cwd: string) => cwd.replace(/\\/g, "/");

it("keeps navigation inventory independent of historical checkout discovery and refreshes the selected checkout", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-enrichment-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", encoding: "utf8" });
  const repo = path.join(root, "repo");
  const linked = path.join(root, "linked");
  const nested = path.join(linked, "nested");
  const plain = path.join(root, "plain");
  const missing = path.join(root, "missing");
  vi.stubEnv("PWRAGENT_GIT_PATH", "git");
  try {
    await mkdir(repo);
    await mkdir(plain);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "core.hooksPath", path.join(root, "empty-hooks"));
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture");
    git(repo, "worktree", "add", "-b", "linked", linked);
    await mkdir(nested);

    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom(repo, linked, nested, plain, missing), { minLength: 1, maxLength: 35, size: "large" }),
      async (history) => {
        const paths = [nested, ...history];
        const rows = paths.map((cwd, index) => ({
          id: `thread-${index}`, cwd, preview: `Thread ${index}`, source: "cli",
          updatedAt: paths.length - index, gitInfo: { branch: "recorded" },
        }));
        let now = 0;
        const client = new CodexAppServerClient({ threadDirectoryEnricher: createThreadDirectoryEnricher({ now: () => now }) });
        client["ensureInitialized"] = async () => {};
        Object.defineProperty(client, "connection", {
          value: { request: async () => ({ data: rows, nextCursor: null }) },
        });
        const registry = {
          listThreads: (params: Parameters<typeof client.listThreads>[0]) =>
            client.listThreads({ ...params, skipArchivedMetadataRefresh: true }),
          withNavigationPrimaryGitRepositories: (threads: unknown[]) => threads,
          hydrateThreadGitWorkingStates: async (threads: unknown[]) => threads,
          withNavigationSubAgentActivity: (threads: unknown[]) => threads,
          getNavigationInputRequestThreadKeys: () => new Set<string>(),
        } as unknown as DesktopBackendRegistry;
        const launches = vi.spyOn(gitSubprocessDiagnostics, "startGit");
        try {
          const index = await loadLocalNavigationQueryIndex({ registry, callerReason: "renderer-navigation-query" });
          expect(index.threads.map((thread) => thread.id)).toEqual(rows.map((row) => row.id));
          expect(launches.mock.calls.filter((call) => call[2] === "directory-enrichment")).toHaveLength(0);
          const [primary, worktree] = git(repo, "worktree", "list", "--porcelain").split("\n")
            .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
          for (const [indexPosition, cwd] of paths.entries()) {
            const [directory] = index.threads[indexPosition]!.linkedDirectories;
            if (cwd === missing) {
              expect(directory).toBeUndefined();
            } else if (cwd === linked || cwd === nested) {
              expect(directory).toMatchObject({ path: normalize(primary!), worktreePath: normalize(worktree!), kind: "worktree" });
            } else {
              expect(directory).toMatchObject({ path: normalize(cwd), kind: "local" });
            }
          }
          const raw = (await client.listThreads({ enrichDirectories: false, skipArchivedMetadataRefresh: true }))[0]!;
          const [selected] = await client.enrichThreadDirectories([raw], "selected-thread");
          expect(selected).toMatchObject({ observedGitBranch: git(nested, "rev-parse", "--abbrev-ref", "HEAD").trim(),
            linkedDirectories: [{ path: normalize(primary!), worktreePath: normalize(worktree!), kind: "worktree" }] });
          git(linked, "checkout", "--detach");
          now += 5_001;
          const [refreshed] = await client.enrichThreadDirectories([raw], "selected-thread");
          expect(refreshed?.observedGitBranch).toBe(git(nested, "rev-parse", "--abbrev-ref", "HEAD").trim());
          git(linked, "checkout", "linked");
        } finally {
          launches.mockRestore();
          await client.close();
        }
      },
    ), { examples: [[[repo]]], numRuns: 8 });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("observes ordinary and linked checkout roots, leaving Git overrides to live verification", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-layout-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", encoding: "utf8" });
  const repo = path.join(root, "Mixed Case");
  const nested = path.join(repo, "nested");
  const alias = path.join(root, "alias");
  const linked = path.join(root, "linked");
  const moved = path.join(root, "Moved Checkout");
  vi.stubEnv("PWRAGENT_GIT_PATH", "git");
  try {
    await mkdir(nested, { recursive: true });
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "core.hooksPath", path.join(root, "empty-hooks"));
    await symlink(nested, alias, "junction");
    const enrich = createThreadDirectoryEnricher();
    // An unborn branch has a real checkout root without an observed commit.
    const unbornPath = git(alias, "rev-parse", "--show-toplevel").trim();
    expect(await readNavigationCheckoutDirectory(alias)).toMatchObject([{ path: unbornPath, kind: "local" }]);
    expect(await enrich(alias)).toMatchObject({ linkedDirectories: [{ path: unbornPath, kind: "local" }] });
    vi.stubEnv("GIT_CEILING_DIRECTORIES", repo);
    expect(() => git(nested, "rev-parse", "--show-toplevel")).toThrow();
    expect(await readNavigationCheckoutDirectory(nested)).toBeUndefined();
    vi.stubEnv("GIT_CEILING_DIRECTORIES", undefined);

    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture");
    git(repo, "worktree", "add", "--detach", linked);
    git(repo, "worktree", "move", linked, moved);
    const movedRoot = git(moved, "rev-parse", "--show-toplevel").trim();
    expect(await readNavigationCheckoutDirectory(linked)).toEqual([]);
    expect(await readNavigationCheckoutDirectory(moved)).toMatchObject([
      { path: normalize(repo), worktreePath: movedRoot, kind: "worktree" },
    ]);
    expect(await enrich(moved)).toMatchObject({ observedGitBranch: "HEAD", linkedDirectories: [{ worktreePath: movedRoot }] });
    git(repo, "worktree", "remove", moved);
    expect(await readNavigationCheckoutDirectory(path.join(moved, "nested"))).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
