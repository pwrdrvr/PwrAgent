import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import {
  buildPullRequestStatusKey,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
  type PrSummary,
} from "@pwragent/shared/contracts/navigation";
import { buildDirectorySummaries } from "@pwragent/shared/directory-navigation";
import { STACK_DETAIL_REUSE_MS } from "@pwragent/shared/stacks/stack-status";
import { NavigationDirectoryScope } from "@pwragent/owner-core/navigation-directory-scope";
import type { NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import * as gitExecutable from "../app-server/git-executable";
import { appendViewerNavigationPins } from "../app-server/navigation-viewer-pins";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { gitSubprocessDiagnostics, type GitSubprocessPurpose } from "../diagnostics/git-subprocess-diagnostics";
import { GitUserRefreshBudget } from "../git-info/read-cache";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { StackReader, StackReadObservation } from "../stacks/stack-reader";
import { isolateProcessGitEnvironment, runIsolatedGitSync } from "./helpers/isolated-git";

const mocks = vi.hoisted(() => ({
  profileStore: undefined as SqliteOverlayStore | undefined,
  messaging: {
    findActiveBindings: vi.fn(async () => []),
    findActiveBindingsForThread: vi.fn(async () => []),
  },
}));

vi.mock("../storage/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => {
    if (!mocks.profileStore) throw new Error("Overlay store not initialized for test");
    return mocks.profileStore;
  },
}));
vi.mock("../messaging/desktop-messaging-store", () => ({ getDesktopMessagingStore: () => mocks.messaging }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: vi.fn() }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));

import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import {
  loadLocalNavigationQueryIndex,
  projectSelectedStackLayers,
  readNavigationStackLayers,
} from "../app-server/navigation-query-source";

type GitLaunchRecord = {
  cwd: string;
  args: string[];
  purpose: GitSubprocessPurpose;
};

const git = (cwd: string, ...args: string[]) => runIsolatedGitSync(cwd, args).trim();
const commit = (cwd: string, message: string) =>
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", message);

function countLaunches(launches: readonly GitLaunchRecord[]) {
  const byPurpose: Partial<Record<GitSubprocessPurpose, number>> = {};
  const byArgv = new Map<string, number>();
  for (const launch of launches) {
    byPurpose[launch.purpose] = (byPurpose[launch.purpose] ?? 0) + 1;
    const key = `${launch.purpose}:${launch.args[0] ?? ""}`;
    byArgv.set(key, (byArgv.get(key) ?? 0) + 1);
  }
  return {
    total: launches.length,
    stackStatus: byPurpose["stack-status"] ?? 0,
    stackCheckout: byPurpose["stack-checkout"] ?? 0,
    byPurpose,
    byArgv,
  };
}

async function createRealGitSidebarFixture(catalogCount: number) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-nav-stack-reuse-")));
  const restoreGit = isolateProcessGitEnvironment();
  const home = path.join(base, "home");
  const pwragentRoot = path.join(base, "pwragent");
  const profile = "stack-reuse-fixture";
  const stateDir = path.join(pwragentRoot, "profiles", profile, "state");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(stateDir, { recursive: true })]);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("PWRAGENT_HOME", pwragentRoot);
  vi.stubEnv("PWRAGENT_PROFILE", profile);

  // 1. Bound stack repo: primary + linked worktree for stack layer s1.
  const boundRoot = path.join(base, "bound-repo");
  git(base, "init", "-q", "-b", "main", boundRoot);
  commit(boundRoot, "bound trunk");
  git(boundRoot, "remote", "add", "origin", "https://github.com/fixture/bound.git");
  const boundTrunk = git(boundRoot, "rev-parse", "HEAD");
  git(boundRoot, "checkout", "-q", "-b", "s1");
  commit(boundRoot, "bound layer 1");
  const boundHead = git(boundRoot, "rev-parse", "HEAD");
  git(boundRoot, "update-ref", "refs/remotes/origin/s1", boundHead);
  git(boundRoot, "config", "branch.s1.remote", "origin");
  git(boundRoot, "config", "branch.s1.merge", "refs/heads/s1");
  git(boundRoot, "checkout", "-q", "main");
  const boundWorktree = path.join(base, "bound-wt1");
  git(boundRoot, "worktree", "add", "-q", boundWorktree, "s1");
  const boundWorktreeReal = await realpath(boundWorktree);
  const writeBoundCatalog = async (overrides?: { head?: string; trunk?: string; branch?: string }) => {
    await writeFile(path.join(boundRoot, ".git", "gh-stack"), JSON.stringify({
      schemaVersion: 1,
      repository: "github.com:fixture/bound",
      stacks: [{
        trunk: { branch: "main", head: overrides?.trunk ?? boundTrunk },
        branches: [{
          branch: overrides?.branch ?? "s1",
          head: overrides?.head ?? boundHead,
          base: overrides?.trunk ?? boundTrunk,
          pullRequest: { number: 11 },
        }],
      }],
    }));
  };
  await writeBoundCatalog();

  // 2. Independent catalog repos (catalogCount - 1 additional stack-bearing clones).
  const independentRepos: { root: string; branch: string; threadId: string; repository: string }[] = [];
  for (let index = 1; index < catalogCount; index++) {
    const repoRoot = path.join(base, `catalog-${index}`);
    git(base, "init", "-q", "-b", "main", repoRoot);
    commit(repoRoot, `catalog ${index} trunk`);
    const trunk = git(repoRoot, "rev-parse", "HEAD");
    const branch = `feat-${index}`;
    git(repoRoot, "checkout", "-q", "-b", branch);
    commit(repoRoot, `catalog ${index} layer`);
    const head = git(repoRoot, "rev-parse", "HEAD");
    const repository = `github.com:fixture/catalog-${index}`;
    await writeFile(path.join(repoRoot, ".git", "gh-stack"), JSON.stringify({
      schemaVersion: 1,
      repository,
      stacks: [{
        trunk: { branch: "main", head: trunk },
        branches: [{ branch, head, base: trunk }],
      }],
    }));
    independentRepos.push({ root: repoRoot, branch, threadId: `catalog-thread-${index}`, repository });
  }

  // Real SQLite overlay store so markThreadSeen / setThreadReaction / overlay writes
  // genuinely advance readOwnerNavigationSourceVersion() and readNavigationSourceVersion().
  const db = StateDb.open(path.join(stateDir, "state.db"), { profileName: profile });
  const overlayStore = new SqliteOverlayStore(db);
  mocks.profileStore = overlayStore;

  let boundPr: PrSummary = {
    provider: "github.com",
    org: "fixture",
    repo: "bound",
    number: 11,
    state: "passing",
    lifecycleState: "open",
    url: "https://github.com/fixture/bound/pull/11",
    headRefName: "s1",
    baseRefName: "main",
    headSha: boundHead,
    baseSha: boundTrunk,
    linkedDirectoryPaths: [boundWorktreeReal],
    explicitlyAttached: true,
  };
  await overlayStore.setThreadPullRequests({
    backend: "codex",
    threadId: "bound-parent",
    prs: [boundPr],
    fetchedAt: Date.now(),
  });
  await overlayStore.setThreadParent({
    backend: "codex",
    threadId: "bound-child",
    parentThreadId: "bound-parent",
  });

  let parentTitle = "Bound stack parent";
  let childTitle = "Bound stack child";

  const buildRawThreads = (): NavigationThreadSummary[] => [
    {
      id: "bound-parent",
      source: "codex",
      title: parentTitle,
      titleSource: "explicit",
      gitBranch: "s1",
      updatedAt: 1_000,
      createdAt: 1_000,
      inbox: { inInbox: true },
      linkedDirectories: [{
        id: boundRoot,
        path: boundRoot,
        worktreePath: boundWorktreeReal,
        kind: "worktree",
        label: "bound-repo",
        gitBranch: "s1",
      }],
    },
    {
      id: "bound-child",
      source: "codex",
      title: childTitle,
      titleSource: "explicit",
      gitBranch: "main",
      updatedAt: 900,
      createdAt: 900,
      inbox: { inInbox: false },
      linkedDirectories: [{
        id: boundRoot,
        path: boundRoot,
        kind: "local",
        label: "bound-repo",
        gitBranch: "main",
      }],
    },
    ...independentRepos.map((repo, index): NavigationThreadSummary => ({
      id: repo.threadId,
      source: "codex",
      title: `Catalog ${index + 1}`,
      titleSource: "explicit",
      gitBranch: repo.branch,
      updatedAt: 500 - index,
      createdAt: 500 - index,
      inbox: { inInbox: false },
      linkedDirectories: [{
        id: repo.root,
        path: repo.root,
        kind: "local",
        label: `catalog-${index + 1}`,
        gitBranch: repo.branch,
      }],
    })),
  ];

  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (method: string, params?: Record<string, unknown>) => {
    const event = { backend: "codex", notification: { method, params: params ?? {} } } as AgentEvent;
    for (const listener of listeners) listener(event);
  };

  const registry = {
    listThreads: vi.fn(async () => buildRawThreads()),
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    withNavigationPrimaryGitRepositories: (rows: NavigationThreadSummary[]) => rows,
    hydrateThreadGitWorkingStates: async (rows: NavigationThreadSummary[]) => rows,
    withNavigationSubAgentActivity: (rows: NavigationThreadSummary[]) => rows,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
    rememberNavigationVisibilityIndex: () => {},
    navigationDirectoryScope: new NavigationDirectoryScope(),
    getStartupProviderRefreshStatus: () => ({ state: "ready" }),
    isIncompleteThreadList: () => false,
    canonicalizeNavigationPullRequests: async (prs: PrSummary[]) =>
      prs.map((pr) => (pr.number === boundPr.number && pr.repo === boundPr.repo ? boundPr : pr)),
    stackThreadHeld: () => false,
    stackRepairActive: async () => false,
  } as unknown as DesktopBackendRegistry;
  vi.mocked(getDesktopBackendRegistry).mockReturnValue(registry);

  const remotePin: NavigationThreadSummary = {
    id: "remote-pin",
    source: "codex",
    title: "Remote pin",
    titleSource: "explicit",
    updatedAt: 800,
    createdAt: 800,
    linkedDirectories: [],
    inbox: { inInbox: false },
    federation: {
      instanceLabel: "Peer",
      ref: buildFederatedThreadRef({ backend: "codex", threadId: "remote-pin", instanceId: "peer" }),
    },
  };
  const viewer = {
    source: {},
    project: async (index: NavigationQueryIndex) => appendViewerNavigationPins(index, [remotePin]),
  };

  const queryStore = new NavigationQueryStore();
  const directoryKey = buildDirectorySummaries({ threads: buildRawThreads() }).find((dir) => dir.path === boundRoot)!.key;

  const readPages = async (scope: "owner" | "viewer") => {
    const loadIndex = () => loadLocalNavigationQueryIndex({
      registry,
      callerReason: "renderer-navigation-query",
      includeStacks: true,
      ...(scope === "viewer" ? { viewer } : {}),
    });
    const scopeKey = `fixture-${scope}`;
    const exactReq: NavigationQueryRequest = {
      protocol: 2,
      consumer: "main-sidebar",
      query: {
        kind: "exact",
        identities: [
          { backend: "codex", threadId: "bound-parent" },
          { backend: "codex", threadId: "bound-child" },
        ],
      },
    };
    const childrenReq: NavigationQueryRequest = {
      protocol: 2,
      consumer: "main-sidebar",
      query: { kind: "children", parent: { backend: "codex", threadId: "bound-parent" } },
    };
    const directoryReq: NavigationQueryRequest = {
      protocol: 2,
      consumer: "main-sidebar",
      query: { kind: "directory", directoryKey },
    };
    const pullRequests = {
      read: async (threads: readonly { backend: string; threadId: string }[]) =>
        threads.map((thread) => (thread.threadId === "bound-parent" ? [boundPr] : [])),
      verify: async (batches: PrSummary[][]) => batches,
    };
    const [exact, children, directory] = await Promise.all([
      queryStore.readPage({ request: exactReq, scopeKey, loadIndex, pullRequests }),
      queryStore.readPage({ request: childrenReq, scopeKey, loadIndex, pullRequests }),
      queryStore.readPage({ request: directoryReq, scopeKey, loadIndex, pullRequests }),
    ]);
    return { exact, children, directory };
  };

  const launches: GitLaunchRecord[] = [];
  const originalStartGit = gitSubprocessDiagnostics.startGit;
  const startGitSpy = vi.spyOn(gitSubprocessDiagnostics, "startGit").mockImplementation((cwd, args, purpose) => {
    launches.push({ cwd, args: [...args], purpose: purpose ?? "unspecified" });
    return originalStartGit.call(gitSubprocessDiagnostics, cwd, args, purpose);
  });
  const userRefreshSpy = vi.spyOn(GitUserRefreshBudget.prototype, "tryTake");

  return {
    base,
    boundRoot,
    boundWorktree: boundWorktreeReal,
    independentRepos,
    overlayStore,
    registry,
    viewer,
    directoryKey,
    launches,
    userRefreshSpy,
    emit,
    readPages,
    readOwnerIndex: () => loadLocalNavigationQueryIndex({
      registry,
      callerReason: "renderer-navigation-query",
      includeStacks: true,
    }),
    readViewerIndex: () => loadLocalNavigationQueryIndex({
      registry,
      callerReason: "renderer-navigation-query",
      includeStacks: true,
      viewer,
    }),
    setParentTitle: (next: string) => { parentTitle = next; },
    setChildTitle: (next: string) => { childTitle = next; },
    setBoundPr: (next: PrSummary) => { boundPr = next; },
    writeBoundCatalog,
    resetCounters: () => {
      launches.length = 0;
      userRefreshSpy.mockClear();
    },
    cleanup: async () => {
      emit("navigation/invalidated");
      startGitSpy.mockRestore();
      userRefreshSpy.mockRestore();
      vi.mocked(getDesktopBackendRegistry).mockReset();
      mocks.profileStore = undefined;
      db.close();
      vi.unstubAllEnvs();
      restoreGit();
      await rm(base, { recursive: true, force: true });
    },
  };
}

describe("desktop sidebar background stack Git reuse", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { catalogCount: 2, label: "two warm catalogs" },
    { catalogCount: 16, label: "sixteen warm catalogs" },
  ])("spends zero stack Git launches and zero user-refresh tokens across seen, reaction, rename, and unrelated PR status updates with $label", { timeout: 60_000 }, async ({ catalogCount }) => {
    const fixture = await createRealGitSidebarFixture(catalogCount);
    try {
      // Cold warm-up for both owner and viewer across exact, children, and directory pages.
      const warmOwner = await fixture.readPages("owner");
      const warmViewer = await fixture.readPages("viewer");
      expect(warmOwner.exact.entries.find((e) => e.row.id === "bound-parent")?.row.stackMemberships).toHaveLength(1);
      expect(warmViewer.exact.entries.find((e) => e.row.id === "bound-parent")?.row.stackMemberships).toHaveLength(1);
      expect(warmOwner.children.entries.map((e) => e.row.id)).toContain("bound-child");
      expect(warmOwner.directory.entries.map((e) => e.row.id)).toContain("bound-parent");
      expect(countLaunches(fixture.launches).stackStatus).toBeGreaterThanOrEqual(catalogCount * 2);

      // 1. Mark row seen (updates SQLite threads -> advances owner navigation source version + event).
      const ownerVersionBeforeSeen = fixture.overlayStore.readOwnerNavigationSourceVersion();
      fixture.resetCounters();
      await fixture.overlayStore.markThreadSeen({
        backend: "codex",
        threadId: "bound-parent",
        seenAt: 2_000,
        seenUpdatedAt: 2_000,
      });
      expect(fixture.overlayStore.readOwnerNavigationSourceVersion()).not.toBe(ownerVersionBeforeSeen);
      fixture.emit("navigation/thread/seen", { threadId: "bound-parent", seenUpdatedAt: 2_000 });
      const seenOwner = await fixture.readPages("owner");
      const seenViewer = await fixture.readPages("viewer");
      const seenCounts = countLaunches(fixture.launches);
      expect(seenCounts.stackStatus, `seen launches: ${JSON.stringify([...seenCounts.byArgv])}`).toBe(0);
      expect(seenCounts.stackCheckout).toBe(0);
      expect(fixture.userRefreshSpy).not.toHaveBeenCalled();
      expect(seenOwner.exact.entries.find((e) => e.row.id === "bound-parent")?.row.inbox.lastSeenUpdatedAt).toBe(2_000);
      expect(seenOwner.exact.entries.find((e) => e.row.id === "bound-parent")?.row.inbox.inInbox).toBe(false);
      expect(seenViewer.directory.entries.find((e) => e.row.id === "bound-parent")?.row.inbox.lastSeenUpdatedAt).toBe(2_000);

      // 2. Change reaction (updates SQLite threads -> advances owner navigation source version + event).
      const ownerVersionBeforeReaction = fixture.overlayStore.readOwnerNavigationSourceVersion();
      fixture.resetCounters();
      await fixture.overlayStore.setThreadReaction({
        backend: "codex",
        threadId: "bound-parent",
        emoji: "rocket",
        present: true,
      });
      expect(fixture.overlayStore.readOwnerNavigationSourceVersion()).not.toBe(ownerVersionBeforeReaction);
      fixture.emit("thread/reactions/updated", { threadId: "bound-parent", reactions: ["rocket"] });
      const reactionOwner = await fixture.readPages("owner");
      const reactionViewer = await fixture.readPages("viewer");
      const reactionCounts = countLaunches(fixture.launches);
      expect(reactionCounts.stackStatus, `reaction launches: ${JSON.stringify([...reactionCounts.byArgv])}`).toBe(0);
      expect(reactionCounts.stackCheckout).toBe(0);
      expect(fixture.userRefreshSpy).not.toHaveBeenCalled();
      expect(reactionOwner.exact.entries.find((e) => e.row.id === "bound-parent")?.row.reactions).toEqual(["rocket"]);
      expect(reactionViewer.exact.entries.find((e) => e.row.id === "bound-parent")?.row.reactions).toEqual(["rocket"]);

      // 3. Rename row (both row title AND stack layer thread title must update with zero Git launches).
      fixture.resetCounters();
      fixture.setParentTitle("Renamed stack parent");
      fixture.setChildTitle("Renamed stack child");
      fixture.emit("thread/name/updated", { threadId: "bound-parent", threadName: "Renamed stack parent", titleSource: "explicit" });
      const renamedOwner = await fixture.readPages("owner");
      const renamedViewer = await fixture.readPages("viewer");
      const renamedCounts = countLaunches(fixture.launches);
      expect(renamedCounts.stackStatus, `rename launches: ${JSON.stringify([...renamedCounts.byArgv])}`).toBe(0);
      expect(renamedCounts.stackCheckout).toBe(0);
      expect(fixture.userRefreshSpy).not.toHaveBeenCalled();
      expect(renamedOwner.exact.entries.find((e) => e.row.id === "bound-parent")?.row.title).toBe("Renamed stack parent");
      expect(renamedViewer.children.entries.find((e) => e.row.id === "bound-child")?.row.title).toBe("Renamed stack child");
      const ownerIndexAfterRename = await fixture.readOwnerIndex();
      const stackLayer = projectSelectedStackLayers(ownerIndexAfterRename, { backend: "codex", threadId: "bound-parent" }).page(0, 1)[0];
      expect(stackLayer?.layer.thread?.title).toBe("Renamed stack parent");

      // 4. Unrelated pullRequest/status/updated for a PR in another repository.
      fixture.resetCounters();
      const unrelatedPr: PrSummary = {
        provider: "github.com",
        org: "other-org",
        repo: "unrelated-repo",
        number: 999,
        state: "failing",
        lifecycleState: "open",
        url: "https://github.com/other-org/unrelated-repo/pull/999",
      };
      fixture.emit("pullRequest/status/updated", {
        prKey: buildPullRequestStatusKey(unrelatedPr),
        pr: unrelatedPr,
      });
      const prOwner = await fixture.readPages("owner");
      const prViewer = await fixture.readPages("viewer");
      const prCounts = countLaunches(fixture.launches);
      expect(prCounts.stackStatus, `unrelated PR launches: ${JSON.stringify([...prCounts.byArgv])}`).toBe(0);
      expect(prCounts.stackCheckout).toBe(0);
      expect(fixture.userRefreshSpy).not.toHaveBeenCalled();
      expect(prOwner.exact.entries.find((e) => e.row.id === "bound-parent")?.row.stackMemberships).toHaveLength(1);
      expect(prViewer.exact.entries.find((e) => e.row.id === "bound-parent")?.row.stackMemberships).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("counts zero physical Git wrapper launches for warm display-only updates across both retention and clone-status reuse paths", { timeout: 60_000 }, async () => {
    const fixture = await createRealGitSidebarFixture(2);
    let now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const realGit = await gitExecutable.resolveGitExecutable();
      const wrapperLog = path.join(fixture.base, "git-wrapper.log");
      const wrapperBin = path.join(fixture.base, "git-wrapper.sh");
      await writeFile(wrapperLog, "");
      await writeFile(
        wrapperBin,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(wrapperLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
      );
      await chmod(wrapperBin, 0o755);
      vi.stubEnv("PWRAGENT_GIT_PATH", wrapperBin);

      const readWrapperLog = async () => (await readFile(wrapperLog, "utf8")).split("\n").filter(Boolean);
      const clearWrapperLog = async () => { await writeFile(wrapperLog, ""); };

      await fixture.readPages("owner");
      await fixture.readPages("viewer");
      expect((await readWrapperLog()).length).toBeGreaterThanOrEqual(4);

      // Past the 1s pool retention window, still within the 15s Git observation TTL.
      now += 1_500;
      await clearWrapperLog();
      fixture.resetCounters();
      await fixture.overlayStore.markThreadSeen({
        backend: "codex",
        threadId: "bound-parent",
        seenAt: 3_000,
        seenUpdatedAt: 3_000,
      });
      fixture.emit("navigation/thread/seen", { threadId: "bound-parent", seenUpdatedAt: 3_000 });
      await fixture.readPages("owner");
      await fixture.readPages("viewer");
      expect(await readWrapperLog()).toEqual([]);
      expect(countLaunches(fixture.launches).total).toBe(0);
      expect(fixture.userRefreshSpy).not.toHaveBeenCalled();

      // Unrelated PR status update past the 1s pool retention window still spends zero physical launches.
      now += 1_500;
      await clearWrapperLog();
      fixture.resetCounters();
      const unrelatedPr: PrSummary = {
        provider: "github.com",
        org: "other-org",
        repo: "another-repo",
        number: 404,
        state: "passing",
        lifecycleState: "open",
        url: "https://github.com/other-org/another-repo/pull/404",
      };
      fixture.emit("pullRequest/status/updated", {
        prKey: buildPullRequestStatusKey(unrelatedPr),
        pr: unrelatedPr,
      });
      await fixture.readPages("owner");
      await fixture.readPages("viewer");
      expect(await readWrapperLog()).toEqual([]);
      expect(countLaunches(fixture.launches).total).toBe(0);
      expect(fixture.userRefreshSpy).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      await fixture.cleanup();
    }
  });

  it("preserves live Git fallback authority under a selected-Git override control", { timeout: 60_000 }, async () => {
    const fixture = await createRealGitSidebarFixture(2);
    try {
      await fixture.readOwnerIndex();
      // A GIT_CONFIG_* override intentionally disables filesystem checkout proofs.
      vi.stubEnv("GIT_CONFIG_COUNT", "1");
      vi.stubEnv("GIT_CONFIG_KEY_0", "user.name");
      vi.stubEnv("GIT_CONFIG_VALUE_0", "OverrideControl");
      fixture.resetCounters();
      fixture.emit("thread/name/updated", { threadId: "bound-parent", threadName: "Under override" });
      await fixture.readOwnerIndex();
      const counts = countLaunches(fixture.launches);
      expect(counts.stackCheckout).toBeGreaterThan(0);
      expect(counts.stackStatus).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refreshes live state on related PR changes, changed refs, moved/added worktrees, config/catalog changes, expiry, and authoritative scopes", { timeout: 90_000 }, async () => {
    const fixture = await createRealGitSidebarFixture(2);
    let now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const warm = await fixture.readOwnerIndex();
      const readBoundLayer = (index: NavigationQueryIndex) =>
        projectSelectedStackLayers(index, { backend: "codex", threadId: "bound-parent" }).page(0, 5)[0];
      expect(readBoundLayer(warm)?.layer.pullRequest?.state).toBe("passing");
      expect(readBoundLayer(warm)?.layer.health).toBe("in_sync");

      // 1. Related PR status update must invalidate and reflect updated PR state immediately.
      const failingPr: PrSummary = {
        provider: "github.com",
        org: "fixture",
        repo: "bound",
        number: 11,
        state: "failing",
        lifecycleState: "open",
        url: "https://github.com/fixture/bound/pull/11",
        headRefName: "s1",
        baseRefName: "main",
        headSha: git(fixture.boundWorktree, "rev-parse", "HEAD"),
        baseSha: git(fixture.boundRoot, "rev-parse", "main"),
        linkedDirectoryPaths: [fixture.boundWorktree],
        explicitlyAttached: true,
      };
      fixture.setBoundPr(failingPr);
      fixture.emit("pullRequest/status/updated", {
        prKey: buildPullRequestStatusKey(failingPr),
        pr: failingPr,
      });
      const afterRelatedPr = await fixture.readOwnerIndex();
      expect(readBoundLayer(afterRelatedPr)?.layer.pullRequest?.state).toBe("failing");

      // 2. Changed refs (new commit on stack branch) must be observed immediately even within TTL.
      commit(fixture.boundWorktree, "local advance on s1");
      fixture.resetCounters();
      fixture.emit("navigation/thread/seen", { threadId: "bound-parent", seenUpdatedAt: 3_000 });
      const afterRefCommit = await fixture.readOwnerIndex();
      expect(countLaunches(fixture.launches).stackStatus).toBeGreaterThan(0);
      expect(readBoundLayer(afterRefCommit)?.layer.health).toBe("needs_push");

      // 3. Moved / registered worktree change must be observed immediately even within TTL.
      const extraWt = path.join(fixture.base, "bound-wt-extra");
      git(fixture.boundRoot, "worktree", "add", "-q", "-b", "extra-branch", extraWt);
      fixture.resetCounters();
      fixture.emit("navigation/thread/seen", { threadId: "bound-parent", seenUpdatedAt: 4_000 });
      await fixture.readOwnerIndex();
      expect(countLaunches(fixture.launches).stackStatus).toBeGreaterThan(0);

      const movedExtraWt = path.join(fixture.base, "bound-wt-extra-moved");
      git(fixture.boundRoot, "worktree", "move", extraWt, movedExtraWt);
      fixture.resetCounters();
      fixture.emit("navigation/thread/seen", { threadId: "bound-parent", seenUpdatedAt: 5_000 });
      await fixture.readOwnerIndex();
      expect(countLaunches(fixture.launches).stackStatus).toBeGreaterThan(0);

      // 4. Config change (branch upstream config in .git/config) must bust the clone status cache.
      git(fixture.boundRoot, "config", "branch.s1.remote", "upstream-changed");
      fixture.resetCounters();
      fixture.emit("navigation/thread/seen", { threadId: "bound-parent", seenUpdatedAt: 6_000 });
      await fixture.readOwnerIndex();
      expect(countLaunches(fixture.launches).stackStatus).toBeGreaterThan(0);

      // 5. Catalog change (.git/gh-stack updated) must be reflected immediately.
      const newHead = git(fixture.boundWorktree, "rev-parse", "HEAD");
      git(fixture.boundRoot, "update-ref", "refs/remotes/origin/s1", newHead);
      git(fixture.boundRoot, "config", "branch.s1.remote", "origin");
      fixture.setBoundPr({ ...failingPr, headSha: newHead });
      await fixture.writeBoundCatalog({ head: newHead });
      fixture.emit("navigation/thread/seen", { threadId: "bound-parent", seenUpdatedAt: 7_000 });
      const afterCatalog = await fixture.readOwnerIndex();
      expect(readBoundLayer(afterCatalog)?.layer.health).toBe("in_sync");

      // 6. Expired observation (advance past STACK_DETAIL_REUSE_MS) must re-run live stack-status Git.
      fixture.resetCounters();
      now += STACK_DETAIL_REUSE_MS + 1;
      await fixture.readOwnerIndex();
      expect(countLaunches(fixture.launches).stackStatus).toBeGreaterThanOrEqual(4);

      // 7. Authoritative scopes (scoped StackReader.read and invalidated selected-stack-detail) always run live Git.
      const reader = new StackReader(() => now);
      const rawRows = await fixture.registry.listThreads({ callerReason: "test" });
      await reader.read(rawRows, []);
      fixture.resetCounters();
      await reader.read(rawRows, [], [fixture.boundRoot]);
      expect(countLaunches(fixture.launches).stackStatus).toBeGreaterThanOrEqual(2);

      fixture.resetCounters();
      fixture.emit("turn/completed", { threadId: "bound-parent" });
      await readNavigationStackLayers({ backend: "codex", threadId: "bound-parent" });
      expect(countLaunches(fixture.launches).stackStatus).toBeGreaterThanOrEqual(4);
    } finally {
      dateNow.mockRestore();
      await fixture.cleanup();
    }
  });

  it("re-verifies checkout relationships when a checkout symlink retargets", { timeout: 60_000 }, async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-retarget-")));
    const restoreGit = isolateProcessGitEnvironment();
    try {
      const repoA = path.join(base, "repo-a");
      const repoB = path.join(base, "repo-b");
      const alias = path.join(base, "alias");
      git(base, "init", "-q", "-b", "main", repoA);
      commit(repoA, "a");
      const trunkA = git(repoA, "rev-parse", "HEAD");
      git(repoA, "checkout", "-q", "-b", "feat-a");
      commit(repoA, "a-feat");
      const headA = git(repoA, "rev-parse", "HEAD");
      await writeFile(path.join(repoA, ".git", "gh-stack"), JSON.stringify({
        schemaVersion: 1,
        repository: "github.com:fixture/repo-a",
        stacks: [{ trunk: { branch: "main", head: trunkA }, branches: [{ branch: "feat-a", head: headA, base: trunkA }] }],
      }));
      git(base, "init", "-q", "-b", "main", repoB);
      commit(repoB, "b");
      const trunkB = git(repoB, "rev-parse", "HEAD");
      git(repoB, "checkout", "-q", "-b", "feat-b");
      commit(repoB, "b-feat");
      const headB = git(repoB, "rev-parse", "HEAD");
      await writeFile(path.join(repoB, ".git", "gh-stack"), JSON.stringify({
        schemaVersion: 1,
        repository: "github.com:fixture/repo-b",
        stacks: [{ trunk: { branch: "main", head: trunkB }, branches: [{ branch: "feat-b", head: headB, base: trunkB }] }],
      }));
      await symlink(repoA, alias, "junction");

      const reader = new StackReader();
      const rows: NavigationThreadSummary[] = [{
        id: "t1",
        source: "codex",
        title: "Aliased",
        titleSource: "explicit",
        gitBranch: "main",
        inbox: { inInbox: false },
        linkedDirectories: [{ id: alias, path: alias, kind: "local", label: "alias" }],
      }];
      expect((await reader.read(rows, [])).stacks[0]?.repository).toBe("github.com:fixture/repo-a");

      await rm(alias);
      await symlink(repoB, alias, "junction");
      expect((await reader.read(rows, [])).stacks[0]?.repository).toBe("github.com:fixture/repo-b");
    } finally {
      restoreGit();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("shares at most one clone Git pass across simultaneous equivalent background reads", { timeout: 60_000 }, async () => {
    const fixture = await createRealGitSidebarFixture(2);
    try {
      // Cold simultaneous owner + viewer reads must coalesce into one pass per clone.
      fixture.resetCounters();
      const [owner, viewer] = await Promise.all([fixture.readOwnerIndex(), fixture.readViewerIndex()]);
      expect(owner.stacks).toHaveLength(2);
      expect(viewer.stacks).toHaveLength(2);
      const concurrentIndexCounts = countLaunches(fixture.launches);
      expect(concurrentIndexCounts.byArgv.get("stack-status:worktree")).toBe(2);
      expect(concurrentIndexCounts.byArgv.get("stack-status:for-each-ref")).toBe(2);

      // Simultaneous background StackReader.read calls on a fresh reader must also coalesce.
      const reader = new StackReader();
      const rows = await fixture.registry.listThreads({ callerReason: "test" });
      fixture.resetCounters();
      const [a, b, c] = await Promise.all([
        reader.read(rows, [], undefined, undefined, new StackReadObservation()),
        reader.read(rows, [], undefined, undefined, new StackReadObservation()),
        reader.read(rows, [], undefined, undefined, new StackReadObservation()),
      ]);
      expect(a.stacks).toEqual(b.stacks);
      expect(b.stacks).toEqual(c.stacks);
      const concurrentReaderCounts = countLaunches(fixture.launches);
      expect(concurrentReaderCounts.byArgv.get("stack-status:worktree")).toBe(2);
      expect(concurrentReaderCounts.byArgv.get("stack-status:for-each-ref")).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("holds display-only reuse and freshness invariants across random operation sequences", { timeout: 120_000 }, async () => {
    const fixture = await createRealGitSidebarFixture(2);
    let now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    type Op =
      | { kind: "seen"; stamp: number }
      | { kind: "reaction"; present: boolean }
      | { kind: "rename"; suffix: number }
      | { kind: "unrelated-pr"; number: number }
      | { kind: "ref-commit" }
      | { kind: "advance"; ms: number };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant("seen" as const), stamp: fc.integer({ min: 10_000, max: 99_999 }) }),
      fc.record({ kind: fc.constant("reaction" as const), present: fc.boolean() }),
      fc.record({ kind: fc.constant("rename" as const), suffix: fc.integer({ min: 1, max: 500 }) }),
      fc.record({ kind: fc.constant("unrelated-pr" as const), number: fc.integer({ min: 100, max: 999 }) }),
      fc.record({ kind: fc.constant("ref-commit" as const) }),
      fc.record({ kind: fc.constant("advance" as const), ms: fc.constantFrom(500, 1_500, STACK_DETAIL_REUSE_MS + 1) }),
    );
    try {
      await fc.assert(fc.asyncProperty(
        fc.array(opArb, { minLength: 3, maxLength: 6 }),
        async (ops) => {
          // Establish a fresh warm observation before each sequence.
          now += STACK_DETAIL_REUSE_MS + 1_000;
          await fixture.readOwnerIndex();
          await fixture.readViewerIndex();
          let observationAge = 0;

          for (const op of ops) {
            fixture.resetCounters();
            if (op.kind === "seen") {
              await fixture.overlayStore.markThreadSeen({
                backend: "codex",
                threadId: "bound-parent",
                seenAt: op.stamp,
                seenUpdatedAt: op.stamp,
              });
              fixture.emit("navigation/thread/seen", { threadId: "bound-parent", seenUpdatedAt: op.stamp });
              const pages = await fixture.readPages("owner");
              expect(pages.exact.entries.find((e) => e.row.id === "bound-parent")?.row.inbox.lastSeenUpdatedAt).toBe(op.stamp);
              if (observationAge < STACK_DETAIL_REUSE_MS) {
                expect(countLaunches(fixture.launches).stackStatus).toBe(0);
                expect(countLaunches(fixture.launches).stackCheckout).toBe(0);
                expect(fixture.userRefreshSpy).not.toHaveBeenCalled();
              }
            } else if (op.kind === "reaction") {
              await fixture.overlayStore.setThreadReaction({
                backend: "codex",
                threadId: "bound-parent",
                emoji: "eyes",
                present: op.present,
              });
              fixture.emit("thread/reactions/updated", { threadId: "bound-parent" });
              const pages = await fixture.readPages("viewer");
              expect(pages.exact.entries.find((e) => e.row.id === "bound-parent")?.row.reactions ?? [])
                .toEqual(op.present ? ["eyes"] : []);
              if (observationAge < STACK_DETAIL_REUSE_MS) {
                expect(countLaunches(fixture.launches).stackStatus).toBe(0);
                expect(countLaunches(fixture.launches).stackCheckout).toBe(0);
                expect(fixture.userRefreshSpy).not.toHaveBeenCalled();
              }
            } else if (op.kind === "rename") {
              const title = `Stack title ${op.suffix}`;
              fixture.setParentTitle(title);
              fixture.emit("thread/name/updated", { threadId: "bound-parent", threadName: title, titleSource: "explicit" });
              const index = await fixture.readOwnerIndex();
              const layer = projectSelectedStackLayers(index, { backend: "codex", threadId: "bound-parent" }).page(0, 1)[0];
              expect(layer?.layer.thread?.title).toBe(title);
              if (observationAge < STACK_DETAIL_REUSE_MS) {
                expect(countLaunches(fixture.launches).stackStatus).toBe(0);
                expect(countLaunches(fixture.launches).stackCheckout).toBe(0);
                expect(fixture.userRefreshSpy).not.toHaveBeenCalled();
              }
            } else if (op.kind === "unrelated-pr") {
              const otherPr: PrSummary = {
                provider: "github.com",
                org: "other",
                repo: "repo",
                number: op.number,
                state: "passing",
                lifecycleState: "open",
                url: `https://github.com/other/repo/pull/${op.number}`,
              };
              fixture.emit("pullRequest/status/updated", { prKey: buildPullRequestStatusKey(otherPr), pr: otherPr });
              await fixture.readPages("owner");
              await fixture.readPages("viewer");
              if (observationAge < STACK_DETAIL_REUSE_MS) {
                expect(countLaunches(fixture.launches).stackStatus).toBe(0);
                expect(countLaunches(fixture.launches).stackCheckout).toBe(0);
                expect(fixture.userRefreshSpy).not.toHaveBeenCalled();
              }
            } else if (op.kind === "ref-commit") {
              commit(fixture.boundWorktree, "prop commit");
              fixture.emit("navigation/thread/seen", { threadId: "bound-parent", seenUpdatedAt: 1 });
              await fixture.readOwnerIndex();
              expect(countLaunches(fixture.launches).stackStatus).toBeGreaterThan(0);
              observationAge = 0;
            } else {
              now += op.ms;
              observationAge += op.ms;
            }
          }
        },
      ), { numRuns: 5 });
    } finally {
      dateNow.mockRestore();
      await fixture.cleanup();
    }
  });
});
