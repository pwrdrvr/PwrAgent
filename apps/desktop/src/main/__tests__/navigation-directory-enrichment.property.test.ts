import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { buildDirectorySummaries } from "@pwragent/shared/directory-navigation";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { loadLocalNavigationQueryIndex } from "../app-server/navigation-query-source";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { createThreadDirectoryEnricher, readNavigationCheckout } from "../git-info/directory-store";
import { StackReader } from "../stacks/stack-reader";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const overlays = vi.hoisted(() => ({
  current: undefined as SqliteOverlayStore | undefined,
  readPrs: vi.fn((threads: Parameters<SqliteOverlayStore["readNavigationPullRequests"]>[0]): PrSummary[][] => threads.map(() => [])),
}));

vi.mock("../app-server/backend-registry", () => ({}));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
vi.mock("../messaging/desktop-messaging-store", () => ({
  getDesktopMessagingStore: () => ({ findActiveBindings: async () => [] }),
}));
vi.mock("../storage/desktop-overlay-store", () => {
  const store = {
    readNavigationQueryIndex: ({ threads }: { threads: AppServerThreadSummary[] }) => {
      const rows = threads.map((thread) => ({ ...thread, inbox: { inInbox: false } }));
      return { threads: rows, directories: buildDirectorySummaries({ threads: rows }) };
    },
    readDirectoryGitStatusCache: async () => ({}),
    listAllActivePrStatusWatches: async () => [],
    readNavigationPullRequests: overlays.readPrs,
  };
  return { getDesktopOverlayStore: () => overlays.current ?? store };
});

const normalize = (cwd: string) => cwd.replace(/\\/g, "/");
const originUrl = "https://github.com/example/project.git";

function navigationFixture(paths: string[], now?: () => number, canonicalize?: (prs: PrSummary[]) => Promise<PrSummary[]>) {
  const rows = paths.map((cwd, index) => ({
    id: `thread-${index}`, cwd, preview: `Thread ${index}`, source: "cli",
    updatedAt: paths.length - index, gitInfo: { branch: "recorded", originUrl },
  }));
  const client = new CodexAppServerClient({ threadDirectoryEnricher: createThreadDirectoryEnricher({ now }) });
  client["ensureInitialized"] = async () => {};
  Object.defineProperty(client, "connection", {
    value: { request: async () => ({ data: rows, nextCursor: null }) },
  });
  let verified: AppServerThreadSummary[] | undefined;
  const registry = {
    listThreads: async (params: NonNullable<Parameters<typeof client.listThreads>[0]> & { forceRefresh?: boolean }) => {
      if (params.enrichDirectories && verified && !params.forceRefresh) return verified;
      const rows = await client.listThreads({
        ...params, revalidateDirectories: params.enrichDirectories && params.forceRefresh, skipArchivedMetadataRefresh: true,
      });
      if (params.enrichDirectories) verified = rows;
      return rows;
    },
    withNavigationPrimaryGitRepositories: (threads: unknown[]) => threads,
    hydrateThreadGitWorkingStates: async (threads: unknown[]) => threads,
    withNavigationSubAgentActivity: (threads: unknown[]) => threads,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
    canonicalizeNavigationPullRequests: canonicalize,
  } as unknown as DesktopBackendRegistry;
  return {
    client, rows,
    read: (refreshProviders = false, includeStacks = false) =>
      loadLocalNavigationQueryIndex({ registry, callerReason: "renderer-navigation-query", refreshProviders, includeStacks }),
    verify: () => loadLocalNavigationQueryIndex({ registry, callerReason: "remove-navigation-directory", requireVerifiedDirectories: true }),
  };
}

it("validates stack attachments per thread only when the caller requests stack membership", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-demand-")));
  const stackRead = vi.spyOn(StackReader.prototype, "read").mockResolvedValue({ stacks: [], catalogs: [] });
  try {
    execFileSync("git", ["-C", root, "init", "--initial-branch=main"], { stdio: "pipe" });
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (count) => {
      const attachment = (number: number): PrSummary => ({
        number, provider: "github.com", org: "example", repo: "project", state: "passing",
        url: `https://github.com/example/project/pull/${number}`,
      });
      const batches = Array.from({ length: count }, (_, i) => [attachment(i * 2 + 1), attachment(i * 2 + 2)]);
      overlays.readPrs.mockClear().mockReturnValue(batches);
      stackRead.mockClear();
      const canonicalize = vi.fn(async (prs: PrSummary[]) => prs.slice(1));
      const { client, read } = navigationFixture(Array.from({ length: count }, () => root), undefined, canonicalize);
      try {
        await read();
        expect(overlays.readPrs).not.toHaveBeenCalled();
        expect(stackRead).not.toHaveBeenCalled();
        await read(false, true);
        expect(canonicalize.mock.calls.map(([batch]) => batch)).toEqual(batches);
        expect(stackRead.mock.calls[0]?.[0].map((row) => row.prs)).toEqual(batches.map((batch) => batch.slice(1)));
      } finally {
        await client.close();
      }
    }), { numRuns: 7, examples: [[1]] });
  } finally {
    overlays.readPrs.mockReset();
    stackRead.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

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
        let now = 0;
        const { client, rows, read } = navigationFixture(paths, () => now);
        const launches = vi.spyOn(gitSubprocessDiagnostics, "startGit");
        try {
          const index = await read();
          expect(index.threads.map((thread) => thread.id)).toEqual(rows.map((row) => row.id));
          expect(launches.mock.calls.filter((call) => call[2] === "directory-enrichment")).toHaveLength(0);
          const [primary, worktree] = git(repo, "worktree", "list", "--porcelain").split("\n")
            .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
          for (const [indexPosition, cwd] of paths.entries()) {
            expect(index.threads[indexPosition]?.gitOriginUrl).toBe(originUrl);
            const [directory] = index.threads[indexPosition]!.linkedDirectories;
            if (cwd === missing) {
              expect(directory).toMatchObject({ path: normalize(primary!), kind: "worktree" });
              expect(normalize(directory!.worktreePath!)).toBe(normalize(missing));
            } else if (cwd === linked || cwd === nested) {
              expect(directory).toMatchObject({ path: normalize(primary!), worktreePath: normalize(worktree!), kind: "worktree" });
            } else {
              expect(directory?.kind).toBe("local");
              expect(normalize(directory!.path)).toBe(normalize(cwd));
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
    ), { examples: [[[repo]], [[plain, repo]], [[missing]]], numRuns: 8 });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])("refreshes a remembered parent mapping for a new nested checkout (config include: %s)", async (includeConfig) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-nested-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", encoding: "utf8" });
  const cwd = path.join(root, "nested");
  const { client, read, verify } = navigationFixture([cwd, root], () => 0);
  vi.stubEnv("PWRAGENT_GIT_PATH", "git");
  try {
    await mkdir(cwd);
    git(root, "init", "--initial-branch=parent");
    git(root, "config", "core.hooksPath", path.join(root, "empty-hooks"));
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture");
    const [raw] = await client.listThreads({ enrichDirectories: false, skipArchivedMetadataRefresh: true });
    await client.enrichThreadDirectories([raw!], "selected-thread");
    expect((await read()).threads[0]).toMatchObject({
      linkedDirectories: [{ path: normalize(root) }], observedGitBranch: "parent",
    });
    const parent = `directory:${normalize(root)}`;
    expect((await verify()).directories.find((directory) => directory.key === parent)?.threadKeys).toHaveLength(2);
    git(cwd, "init", "--initial-branch=child");
    if (includeConfig) {
      const config = path.join(root, "extra.conf");
      await writeFile(config, "[gc]\n  auto = 0\n");
      git(cwd, "config", "include.path", config);
    }
    const launches = vi.spyOn(gitSubprocessDiagnostics, "startGit");
    try {
      const [thread] = (await read(true)).threads;
      expect(thread).toMatchObject({ linkedDirectories: [{ path: git(cwd, "rev-parse", "--show-toplevel").trim() }] });
      expect(thread?.observedGitBranch).toBeUndefined();
      expect(launches.mock.calls.filter((call) => call[2] === "directory-enrichment")).toHaveLength(0);
      const visible = await read(true);
      const verified = await verify();
      const members = (index: typeof visible) => Object.fromEntries(index.directories.map(({ key, threadKeys }) => [key, threadKeys]));
      expect(members(verified)).toEqual(members(visible));
      expect(members(verified)[parent]).toEqual(["codex:thread-1"]);
    } finally {
      launches.mockRestore();
    }
  } finally {
    await client.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("groups raw navigation threads by Git's root for a valid HEAD symlink", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-head-link-")));
  const nested = path.join(root, "nested");
  const { client, read } = navigationFixture([nested]);
  const restore = isolateProcessGitEnvironment();
  const launches = vi.spyOn(gitSubprocessDiagnostics, "startGit");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe", encoding: "utf8" });
  try {
    await mkdir(nested);
    git("init", "--initial-branch=topic");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "topic");
    const head = path.join(root, ".git", "HEAD");
    await rm(head);
    await symlink("refs/heads/topic", head);
    const checkout = git("-C", nested, "rev-parse", "--show-toplevel").trim();
    expect(checkout).toBe(root);
    expect((await readNavigationCheckout(nested, true))?.directories).toMatchObject([{ path: checkout }]);
    const index = await read();
    expect(index.threads[0]?.linkedDirectories).toMatchObject([{ path: checkout }]);
    expect(index.directories.find(({ key }) => key === `directory:${normalize(checkout)}`)?.threadKeys)
      .toEqual(["codex:thread-0"]);
    expect(launches).not.toHaveBeenCalled();
  } finally {
    launches.mockRestore();
    await client.close();
    restore();
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
    expect((await readNavigationCheckout(alias))?.directories).toMatchObject([{ path: unbornPath, kind: "local" }]);
    expect(await enrich(alias)).toMatchObject({ linkedDirectories: [{ path: unbornPath, kind: "local" }] });
    vi.stubEnv("GIT_CEILING_DIRECTORIES", repo);
    expect(() => git(nested, "rev-parse", "--show-toplevel")).toThrow();
    expect(await readNavigationCheckout(nested)).toBeUndefined();
    vi.stubEnv("GIT_CEILING_DIRECTORIES", undefined);

    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture");
    git(repo, "worktree", "add", "--detach", linked);
    const admin = git(linked, "rev-parse", "--absolute-git-dir").trim();
    const backlink = path.join(admin, "gitdir");
    const originalBacklink = await readFile(backlink, "utf8");
    const linkedNested = path.join(linked, "nested");
    await mkdir(linkedNested);
    await writeFile(backlink, `${originalBacklink}${" ".repeat(1024 * 1024)}`);
    expect((await readNavigationCheckout(linkedNested))?.directories).toBeUndefined();
    await writeFile(backlink, originalBacklink);
    git(repo, "worktree", "move", linked, moved);
    const movedRoot = git(moved, "rev-parse", "--show-toplevel").trim();
    expect((await readNavigationCheckout(linked))?.directories).toEqual([]);
    expect((await readNavigationCheckout(moved))?.directories).toMatchObject([
      { path: normalize(repo), worktreePath: movedRoot, kind: "worktree" },
    ]);
    expect(await enrich(moved)).toMatchObject({ observedGitBranch: "HEAD", linkedDirectories: [{ worktreePath: movedRoot }] });
    git(repo, "worktree", "remove", moved);
    expect((await readNavigationCheckout(path.join(moved, "nested")))?.directories).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("matches Git discovery for a nested bare boundary and a separate Git directory", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-layout-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", encoding: "utf8" });
  const mirror = path.join(root, "mirror.git");
  const mirrorCwd = path.join(mirror, "objects");
  const checkout = path.join(root, "checkout");
  const checkoutCwd = path.join(checkout, "nested");
  const linked = path.join(root, "linked");
  // Visit the linked checkout before its primary to exercise order-independent grouping.
  const { client, read, verify } = navigationFixture([mirrorCwd, linked, checkoutCwd]);
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  overlays.current = store;
  vi.stubEnv("PWRAGENT_GIT_PATH", "git");
  try {
    git(root, "init", "--initial-branch=outer");
    git(root, "init", "--bare", mirror);
    await mkdir(checkoutCwd, { recursive: true });
    git(checkout, "init", "--separate-git-dir", path.join(root, "admin"));
    git(checkout, "config", "core.hooksPath", path.join(root, "empty-hooks"));
    git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture");
    git(checkout, "worktree", "add", "--detach", linked);
    const admin = git(checkout, "rev-parse", "--absolute-git-dir").trim();
    await store.addLinkedDirectory({ backend: "codex", threadId: "thread-1", directory: {
      id: normalize(linked), label: "Admin", path: admin, kind: "worktree", worktreePath: normalize(linked),
    } });
    expect(() => git(mirrorCwd, "rev-parse", "--show-toplevel")).toThrow();
    const separateRoot = git(checkoutCwd, "rev-parse", "--show-toplevel").trim();
    for (const index of [await read(), await verify()]) {
      expect(index.threads.map((thread) => normalize(thread.linkedDirectories[0]!.path)))
        .toEqual([normalize(mirrorCwd), separateRoot, separateRoot]);
      expect(index.threads[1]?.linkedDirectories[0]).toMatchObject({
        kind: "worktree", worktreePath: git(linked, "rev-parse", "--show-toplevel").trim(),
      });
      expect(new Set(index.directories.find(({ path }) => path === separateRoot)?.threadKeys))
        .toEqual(new Set(["codex:thread-1", "codex:thread-2"]));
    }
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.extraLinkedDirectories[0]?.path).toBe(admin);
  } finally {
    await client.close();
    overlays.current = undefined;
    db.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
