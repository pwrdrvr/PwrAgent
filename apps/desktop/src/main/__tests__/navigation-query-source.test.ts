import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { StackSummary } from "@pwragent/shared/stacks/stack-status";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerBackendScope } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationLaunchpadDraft, NavigationQueryRequest, NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import { buildPullRequestStatusKey } from "@pwragent/shared/contracts/navigation";
import { buildDirectorySummaries, canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import { findPeerCounterpartDirectory } from "@pwragent/shared/federation-project-match";
import type { ThreadPullRequestWatchSummary } from "@pwragent/shared/contracts/thread-tools";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import { appendViewerNavigationPins } from "../app-server/navigation-viewer-pins";
import { buildPrependPinRank } from "@pwragent/shared/thread-pins";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { getDesktopBackendRegistry, type DesktopBackendRegistry } from "../app-server/backend-registry";
import type { NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import type { NavigationDirectoryGitStatus } from "@pwragent/shared/contracts/navigation";
import budgets from "./fixtures/navigation-listing-budgets.json";
import { isolateProcessGitEnvironment, runIsolatedGit } from "./helpers/isolated-git";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";

const mocks = vi.hoisted(() => {
  const findActiveBindings = vi.fn(async (): Promise<MessagingBindingRecord[]> => []);
  return {
    profileStore: undefined as SqliteOverlayStore | undefined,
    store: {
      readNavigationPullRequests: vi.fn((): PrSummary[][] => []),
      readNavigationQueryThreads: vi.fn(({ threads }: { threads: NavigationThreadSummary[] }) => ({
        threads: threads.map((thread) => ({ ...thread, inbox: thread.inbox ?? { inInbox: false } })),
      })),
      readNavigationQueryDirectories: (threads: NavigationThreadSummary[]) => ({ directories: buildDirectorySummaries({ threads }) }),
      readNavigationSourceVersion: vi.fn(() => "unchanged"),
      getThreadPrAutoDispatchPending: vi.fn(async () => undefined),
      readNavigationQueryIndex: vi.fn((_params: { threads: NavigationThreadSummary[] }): NavigationQueryIndex => ({ threads: [], directories: [] })),
      readDirectoryGitStatusCache: vi.fn(async (): Promise<Record<string, { gitStatus: NavigationDirectoryGitStatus }>> => ({})),
      listAllActivePrStatusWatches: vi.fn(async (): Promise<ThreadPullRequestWatchSummary[]> => []),
    },
    messaging: {
      findActiveBindings,
      // A one-thread index uses the per-thread query. Answer it from the same
      // rows without counting a full read.
      findActiveBindingsForThread: async (params: { backend: string; threadId: string }) =>
        (await findActiveBindings.getMockImplementation()!()).filter((binding) =>
          binding.threadId === params.threadId && (!binding.backend || binding.backend === params.backend)),
    },
  };
});
vi.mock("../storage/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.profileStore ?? mocks.store }));
vi.mock("../messaging/desktop-messaging-store", () => ({ getDesktopMessagingStore: () => mocks.messaging }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: vi.fn() }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
import { loadLocalNavigationQueryIndex, loadSidebarNavigationQueryIndex, navigationPullRequestProjection, navigationQueryShowsStacks, projectBoundNavigationStacks, projectSelectedStackLayers, readNavigationStackLayers } from "../app-server/navigation-query-source";
import { StackReader, readStackClones } from "../stacks/stack-reader";
import { StackOperationsService } from "../stacks/stack-operations-service";
import { resolveNavigationWorktreeProjects } from "../app-server/navigation-worktree-projects";
import * as worktreeProjects from "../app-server/navigation-worktree-projects";
import * as checkoutStore from "../git-info/directory-store";
import { runGitCommand } from "../app-server/git-executable";
import { configureBundledGit } from "../bundled-git";
import { gitSubprocessDiagnostics, prGitSubprocessCaller } from "../diagnostics/git-subprocess-diagnostics";
import { filterStoredDiscoveredPullRequests, type PrAttachmentDemand } from "../pr-status/pr-detection";
import { resolveWorktreeRepositoryDirectory } from "../git-info/worktree-store";
import { NavigationQueryPool } from "../app-server/navigation-query-pool";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { NavigationDirectoryScope } from "@pwragent/owner-core/navigation-directory-scope";
import * as namedBindings from "../messaging/named-messaging-bindings";
import { NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";
import { navigationDirectoryGitRevisions, projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";

function createSource(coverage: "complete" | "checking" | "degraded" = "complete") {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const listeners = new Set<(event: AgentEvent) => void>();
  const listThreads = vi.fn(async (_params?: { forceRefresh?: boolean }): Promise<NavigationThreadSummary[]> => { await gate; return []; });
  const rememberNavigationVisibilityIndex = vi.fn();
  const navigationDirectoryScope = new NavigationDirectoryScope();
  const rememberDirectoryScope = vi.spyOn(navigationDirectoryScope, "remember");
  const registry = {
    listThreads,
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    withNavigationPrimaryGitRepositories: (threads: []) => threads,
    hydrateThreadGitWorkingStates: async (threads: []) => threads,
    withNavigationSubAgentActivity: (threads: []) => threads,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
    rememberNavigationVisibilityIndex,
    navigationDirectoryScope,
    getStartupProviderRefreshStatus: () => ({ state: coverage === "checking" ? "checking" : "ready" }),
    isIncompleteThreadList: () => coverage === "degraded",
  } as unknown as DesktopBackendRegistry;
  return {
    registry, finish, listThreads, listeners, rememberNavigationVisibilityIndex, rememberDirectoryScope, navigationDirectoryScope,
    read: (backend?: AppServerBackendScope) => loadLocalNavigationQueryIndex({ registry, backend, callerReason: "source-event-regression" }),
    refresh: () => loadLocalNavigationQueryIndex({ registry, callerReason: "source-event-regression", refreshProviders: true }),
    emit: (method: string) => {
      const event = { backend: "codex", notification: { method, params: { threadId: "thread" } } } as AgentEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

it.each([8, 16, 32])("keeps a filter switch and %i row changes off inventory discovery", async (size) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const source = createSource();
  const store = new NavigationQueryStore();
  const threads: NavigationThreadSummary[] = Array.from({ length: size }, (_, i) => ({
    id: String(i), source: "codex", title: String(i), titleSource: "explicit", projectKey: "/fixture/" + i,
    linkedDirectories: [], inbox: { inInbox: false }, threadStatus: "idle",
  }));
  source.listThreads.mockResolvedValue(threads);
  const checkout = vi.spyOn(checkoutStore, "readNavigationCheckouts").mockResolvedValue([]);
  const joined = mocks.store.readNavigationQueryIndex;
  const original = joined.getMockImplementation()!;
  joined.mockImplementation(({ threads }) => ({ ...mocks.store.readNavigationQueryThreads({ threads }), directories: [] }));
  const read = (active = false) => store.readPage({
    scopeKey: "warm-sidebar", request: { protocol: 2, consumer: "main-sidebar",
      query: { kind: "lens", lens: "attention", ...(active ? { attention: "active" as const } : {}) } },
    loadIndex: () => loadSidebarNavigationQueryIndex({ registry: source.registry, callerReason: "renderer-navigation-query", includeStacks: true }),
  });
  const work = () => [source.listThreads.mock.calls.length,
    checkout.mock.calls.reduce((total, [paths]) => total + paths.length, 0), joined.mock.calls.length];
  try {
    const discovered = Promise.withResolvers<void>();
    source.registry.publishLocalEvent = async (event) => {
      if (event.notification.method === "navigation/invalidated") discovered.resolve();
    };
    await read();
    await discovered.promise;
    source.listThreads.mockClear();
    checkout.mockClear();
    joined.mockClear();
    await vi.advanceTimersByTimeAsync(15_001);
    await read(true);
    const switched = work();
    for (const thread of threads) {
      thread.threadStatus = "active";
      for (const listener of source.listeners) listener({ backend: "codex", notification: {
        method: "thread/status/changed", params: { threadId: thread.id, status: { type: "active" } },
      } });
    }
    const page = await read(true);
    expect(page.counts.active).toBe(size);
    expect({ switched, afterBurst: work() }).toEqual({ switched: [0, 0, 0], afterBurst: [0, 0, 0] });
  } finally {
    joined.mockImplementation(original);
    checkout.mockRestore();
    vi.useRealTimers();
  }
});

it("withdraws a sibling's inherited checkout after the only donor is archived", async () => {
  const source = createSource();
  const directory = { kind: "local" as const, id: "/example", label: "example", path: "/example" };
  const base = { source: "codex" as const, title: "Example", titleSource: "explicit" as const, gitOriginUrl: "https://test/repo.git", inbox: { inInbox: false } };
  source.listThreads.mockResolvedValue([{ ...base, id: "donor", projectKey: directory.path, linkedDirectories: [directory] },
    { ...base, id: "child", linkedDirectories: [] }]);
  const checkout = vi.spyOn(checkoutStore, "readNavigationCheckouts").mockResolvedValue([]);
  const joined = mocks.store.readNavigationQueryIndex;
  const original = joined.getMockImplementation()!;
  joined.mockImplementation(({ threads }) => ({ ...mocks.store.readNavigationQueryThreads({ threads }), directories: [] }));
  const read = () => loadSidebarNavigationQueryIndex({ registry: source.registry, callerReason: "donor-test" });
  try {
    await read();
    await vi.waitFor(async () => expect((await read()).threads[1]?.linkedDirectories).toEqual([directory]));
    for (const listener of source.listeners) listener({ backend: "codex", notification: { method: "thread/archived", params: { threadId: "donor" } } });
    await vi.waitFor(async () => expect((await read()).threads.map((row) => [row.id, row.linkedDirectories])).toEqual([["child", []]]));
    expect(source.listThreads).toHaveBeenCalledTimes(1);
  } finally { joined.mockImplementation(original); checkout.mockRestore(); }
});

it("verifies a registered directory even when the seed contains no provider rows", async () => {
  const source = createSource();
  source.finish();
  const directory: NavigationQueryIndex["directories"][number] = { key: "directory:/registered", kind: "directory",
    path: "/registered", label: "Registered", threadKeys: [], needsAttentionCount: 0 };
  const joined = mocks.store.readNavigationQueryIndex;
  const original = joined.getMockImplementation()!;
  joined.mockReturnValue({ threads: [], directories: [directory] });
  const probe = vi.spyOn(worktreeProjects, "resolveNavigationWorktreeProjects").mockImplementation(async (directories) => ({ directories }));
  try {
    await loadSidebarNavigationQueryIndex({ registry: source.registry, callerReason: "registered-directory" });
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    expect(source.listThreads).toHaveBeenCalledTimes(1);
  } finally { joined.mockImplementation(original); probe.mockRestore(); }
});

it("evicts an older live backend scope when several individually admissible inventories exceed the shared byte budget", async () => {
  const source = createSource();
  const rows = (["codex", "claude"] as const).map((source) => ({ id: source, source, title: "x".repeat(660_000),
    titleSource: "explicit" as const, linkedDirectories: [], inbox: { inInbox: false } }));
  source.listThreads.mockImplementation(async (params) =>
    rows.filter((row) => !params || !("backend" in params) || !params.backend || row.source === params.backend));
  const joined = mocks.store.readNavigationQueryIndex;
  const original = joined.getMockImplementation()!;
  joined.mockImplementation(({ threads }) => ({ ...mocks.store.readNavigationQueryThreads({ threads }), directories: [] }));
  const read = (backend: AppServerBackendScope) => loadSidebarNavigationQueryIndex({ registry: source.registry, backend, callerReason: "budget" });
  try {
    await read("all");
    await read("all");
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    await read("codex");
    await read("claude");
    await read("all");
    expect(source.listThreads).toHaveBeenCalledTimes(4);
  } finally { joined.mockImplementation(original); }
});

it("drops a revoked named messaging binding from the next warm sidebar read", async () => {
  const source = createSource();
  const thread: NavigationThreadSummary = { id: "thread", source: "codex", title: "Thread", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false } };
  const binding = { id: "named-binding", backend: "codex", threadId: thread.id, createdAt: 1,
    channel: { channel: "telegram", connectionId: "bot", conversation: { kind: "topic", id: "topic" } },
  } as MessagingBindingRecord;
  const previous = mocks.store.readNavigationQueryIndex.getMockImplementation()!;
  mocks.store.readNavigationQueryIndex.mockImplementation(() => ({ threads: [thread], directories: [] }));
  let bindings = [binding];
  namedBindings.setNamedMessagingBindingReader(async () => bindings);
  const read = () => loadSidebarNavigationQueryIndex({ registry: source.registry, callerReason: "renderer-navigation-query" });
  try {
    source.finish();
    expect((await read()).threads[0]?.messagingBindings).toHaveLength(1);
    bindings = [];
    namedBindings.noteMessagingBindingsChange();
    await vi.waitFor(async () => expect((await read()).threads[0]?.messagingBindings ?? []).toEqual([]));
    expect(source.listThreads).toHaveBeenCalledTimes(1);
  } finally {
    namedBindings.setNamedMessagingBindingReader(undefined);
    mocks.store.readNavigationQueryIndex.mockImplementation(previous);
  }
});

it("stores only serviceable stacks and pages past the compact membership preview", () => {
  fc.assert(fc.property(fc.integer({ min: 9, max: 36 }), fc.integer({ min: 1, max: 24 }), (selected, unrelated) => {
    const thread: NavigationThreadSummary = {
      id: "selected", source: "codex", title: "Selected", titleSource: "derived",
      linkedDirectories: [], inbox: { inInbox: false },
    };
    const inventory = Array.from({ length: selected + unrelated }, (_, i): StackSummary => ({
      key: `stack-${i}`, name: `Stack ${i}`, repository: "github.com:fixture/project", inferred: false,
      trunk: "main", layers: [{ branch: `branch-${i}`, parent: "main", health: "in_sync", role: "layer",
        ...(i < selected ? { thread: { key: "codex:selected", title: "Selected" } }
          : { thread: { key: "codex:outside-inventory", title: "Unrelated" } }),
      }],
    }));
    const projection = projectBoundNavigationStacks([thread], inventory)!;
    expect(projection.stacks?.map(({ key }) => key)).toEqual(inventory.slice(0, selected).map(({ key }) => key));
    expect(projection.threads[0]?.stackMemberships).toHaveLength(8);
    const detail = projectSelectedStackLayers({ directories: [], ...projection }, { backend: "codex", threadId: "selected" });
    expect(detail.count).toBe(selected);
    expect([...detail.page(0, 8), ...detail.page(8, selected)].map(({ stackKey }) => stackKey))
      .toEqual(inventory.slice(0, selected).map(({ key }) => key));
  }));
});

it("keeps the lead PR's position even when the thread holds more layers than the preview", () => {
  fc.assert(fc.property(fc.integer({ min: 9, max: 36 }), fc.constantFrom("all", "above base", "top"), (height, held) => {
    const prs = Array.from({ length: height }, (_, index) => ({
      number: 1 + index, provider: "github.com", org: "fixture", repo: "project",
      url: `https://github.com/fixture/project/pull/${index + 1}`, lifecycleState: "open" as const,
      state: "passing" as const, createdAt: index + 1,
    }));
    const thread: NavigationThreadSummary = {
      id: "selected", source: "codex", title: "Selected", titleSource: "derived",
      linkedDirectories: [], inbox: { inInbox: false }, prs,
    };
    const stack: StackSummary = {
      key: "fixture", name: "stack-1", repository: "github.com:fixture/project", inferred: false, trunk: "main",
      layers: prs.map((pr, index) => ({
        branch: `stack-${index + 1}`, parent: index ? `stack-${index}` : "main",
        pullRequest: { number: pr.number, lifecycleState: "open" },
        thread: { key: "codex:selected", title: "Selected" }, health: "in_sync", role: "holder",
        ...(held === "all" || (held === "above base" && index > 0) || index === height - 1 ? { heldBy: { branch: "base", reason: "CI running" } } : {}),
      })),
    };
    const row = projectBoundNavigationStacks([thread], [stack])!.threads[0]!;
    const members = row.stackMemberships!;
    const expectedLead = held === "all" ? height : held === "above base" ? 1 : height - 1;
    expect(row.stackLeadPrKey).toBe(buildPullRequestStatusKey(prs[expectedLead - 1]!));
    expect(members).toHaveLength(8);
    expect(members).toContainEqual(expect.objectContaining({ position: expectedLead, number: expectedLead, trunk: "main" }));
  }));
});

it.each([false, true])("omits stale automatic attachment evidence when the stack branch is checked out: %s", async (checkedOut) => {
  const source = createSource();
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-stale-stack-")));
  const restoreGit = isolateProcessGitEnvironment();
  try {
    await runIsolatedGit(directory, ["init", "-b", "main"]);
    await runIsolatedGit(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--allow-empty", "-m", "base"]);
    const head = (await runIsolatedGit(directory, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(directory, ".git", "gh-stack"), JSON.stringify({
      schemaVersion: 1, repository: "github.com:old/remote",
      stacks: [{ trunk: { branch: "main", head }, branches: [{ branch: "topic", head, base: head, pullRequest: { number: 41 } }] }],
    }));
    const worktree = path.join(directory, "linked");
    if (checkedOut) await runIsolatedGit(directory, ["worktree", "add", "-b", "topic", worktree]);
    const cwd = checkedOut ? worktree : directory;
    const thread: NavigationThreadSummary = {
      source: "codex", id: "stale-stack", title: "Stale stack", titleSource: "derived", inbox: { inInbox: false },
      gitBranch: checkedOut ? "topic" : "main", linkedDirectories: [{ id: cwd, path: cwd, label: "Fixture", kind: "local" }],
    };
    const stalePr: PrSummary = {
      number: 41, provider: "github.com", org: "old", repo: "remote", state: "passing",
      url: "https://github.com/old/remote/pull/41", linkedDirectoryPaths: [cwd], headSha: head, mergeState: "conflicting",
    };
    const canonicalize = vi.fn(async (_prs: PrSummary[], _demand?: unknown, verify = true) => verify ? [] : [stalePr]);
    const registry = { ...source.registry, canonicalizeNavigationPullRequests: canonicalize } as unknown as DesktopBackendRegistry;
    vi.mocked(getDesktopBackendRegistry).mockReturnValue(registry);
    mocks.store.readNavigationQueryIndex.mockReturnValueOnce({ directories: [], threads: [thread] });
    mocks.store.readNavigationPullRequests.mockReturnValueOnce([[stalePr]]);
    source.finish();
    const detail = await readNavigationStackLayers({ backend: thread.source, threadId: thread.id });
    // If the checkout validator had not run, the stored PR would bind the
    // thread as the holder of that layer without a checked-out topic branch.
    expect(detail.count).toBe(checkedOut ? 1 : 0);
    if (checkedOut) {
      expect(detail.page(0, 1)[0]?.layer).toMatchObject({
        role: "layer", pullRequest: { number: 41 }, unsettled: "settlement unknown",
      });
    }
    expect(canonicalize).toHaveBeenNthCalledWith(1, [stalePr], expect.objectContaining({ allowForgeLookup: false }), false);
    expect(canonicalize).toHaveBeenNthCalledWith(2, [stalePr], expect.objectContaining({ allowForgeLookup: false }));
  } finally {
    vi.mocked(getDesktopBackendRegistry).mockReset();
    restoreGit();
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not validate automatic attachments that cannot participate in a navigation stack", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-stack-admission-")));
  const restoreGit = isolateProcessGitEnvironment();
  const source = createSource();
  const original = gitSubprocessDiagnostics.startGit;
  const starts = vi.spyOn(gitSubprocessDiagnostics, "startGit");
  const validationPaths = new Set<string>();
  starts.mockImplementation((...args) => {
    if (prGitSubprocessCaller.getStore() === "pr-stored-attachment-validation") validationPaths.add(args[0]);
    return original.call(gitSubprocessDiagnostics, ...args);
  });
  try {
    await runIsolatedGit(root, ["init", "-b", "main"]);
    await runIsolatedGit(root, ["remote", "add", "origin", "https://github.com/fixture/no-stack.git"]);
    const registry = {
      ...source.registry,
      canonicalizeNavigationPullRequests: (prs: PrSummary[], demand: NonNullable<Parameters<typeof filterStoredDiscoveredPullRequests>[1]>["demand"], verify = true) =>
        verify ? filterStoredDiscoveredPullRequests(prs, { demand }) : prs,
    } as unknown as DesktopBackendRegistry;
    source.finish();
    await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 5 }),
      async (numbers) => {
        const threads = numbers.map((number): NavigationThreadSummary => ({
          source: "codex", id: `thread-${number}`, title: "Fixture", titleSource: "derived", inbox: { inInbox: false },
          gitBranch: `topic-${number}`, linkedDirectories: [{ id: root, path: root, label: "Fixture", kind: "local" }],
        }));
        const attachments = numbers.map((number): PrSummary[] => [{
          number, provider: "github.com", org: "fixture", repo: "no-stack", state: "passing", lifecycleState: "open",
          url: `https://github.com/fixture/no-stack/pull/${number}`, headRefName: `topic-${number}`, baseRefName: "main",
          linkedDirectoryPaths: [root],
        }]);
        mocks.store.readNavigationQueryIndex.mockReturnValueOnce({ threads, directories: [] });
        mocks.store.readNavigationPullRequests.mockReturnValueOnce(attachments);
        const result = await loadLocalNavigationQueryIndex({
          registry, callerReason: "fixture-navigation-stack-admission", includeStacks: true, refreshProviders: true,
        });
        source.emit("thread/started");
        expect(result.threads).toHaveLength(numbers.length);
        expect(result.stacks ?? []).toEqual([]);
        // PRs sharing only a trunk cannot make an inferred stack. With no
        // tracked catalog, their checkout metadata cannot affect this read.
        expect(validationPaths.size).toBe(0);
      }), { numRuns: 8 });
  } finally {
    starts.mockRestore();
    restoreGit();
    await rm(root, { recursive: true, force: true });
  }
});

it("publishes the repository once when a same-named worktree has a saved project registration", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-project-index-")));
  const previous = mocks.store.readNavigationQueryIndex.getMockImplementation();
  try {
    const repo = canonicalizeNavigationPath(path.join(root, "Project"));
    const worktree = canonicalizeNavigationPath(path.join(root, ".codex", "worktrees", "task", "Project"));
    await mkdir(repo);
    await runGitCommand(repo, ["init"]);
    await runGitCommand(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"]);
    await runGitCommand(repo, ["worktree", "add", "--detach", worktree]);
    const repositoryKey = "github.com/example/project";
    const repoKey = `directory:${repo}`;
    const worktreeKey = `directory:${worktree}`;
    const launchpad = (checkout: string, backend: NavigationLaunchpadDraft["backend"]): NavigationLaunchpadDraft => ({
      directoryKey: `directory:${checkout}`, directoryKind: "directory", directoryPath: checkout, directoryLabel: "Project",
      backend, executionMode: "default", workMode: "local", prompt: "", registeredAt: 1, createdAt: 1, updatedAt: 1,
    });
    const thread: NavigationThreadSummary = {
      id: "worktree-thread", source: "codex", title: "Worktree thread", titleSource: "derived", projectKey: worktree,
      linkedDirectories: [{ id: worktree, path: worktree, label: "Project", kind: "worktree" }], inbox: { inInbox: false },
    };
    for (const parentRegistered of [false, true]) {
      const source = createSource();
      source.listThreads.mockResolvedValue([thread]);
      const directoryOverlays = { [repoKey]: { directoryKey: repoKey, pinnedRank: "1024", directoryThreadsCollapsed: true } };
      mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => ({
        threads,
        directoryOverlays,
        directories: buildDirectorySummaries({ threads, directoryOverlayByKey: directoryOverlays, launchpadsByKey: {
          [worktreeKey]: launchpad(worktree, "codex"),
          ...(parentRegistered ? { [repoKey]: launchpad(repo, "claude") } : {}),
        } }).map((directory) => ({ ...directory, repositoryKey })),
      }));
      mocks.store.readDirectoryGitStatusCache.mockResolvedValue({
        [repoKey]: { gitStatus: { currentBranch: "main" } },
        [worktreeKey]: { gitStatus: { currentBranch: "topic", originRepository: repositoryKey } },
      });

      const index = await source.read();
      expect(index.worktreeProjectAliases).toEqual({ [`directory:${repo}`]: [`directory:${worktree}`] });
      const projects = projectNavigationQuery({ index, request: {
        protocol: 2, inventory: "owner", consumer: "agent-tool", query: { kind: "directory-index" },
      } }).directories!.filter((row) => row.kind === "directory");
      expect(projects.map((row) => row.path)).toEqual([repo]);
      expect(findPeerCounterpartDirectory({ kind: "directory", label: "Project", repositoryKey }, projects))
        .toMatchObject({ key: repoKey, counts: { total: 1 }, gitStatus: { currentBranch: "main" }, pinnedRank: "1024", directoryThreadsCollapsed: true });
      const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "owner", query: { kind: "directory-index" } };
      const pins: NavigationQueryRequest = { ...request, query: { kind: "group-members", roots: [{ backend: "codex", threadId: thread.id }] } };
      const store = new NavigationQueryStore();
      const read = vi.fn((sent: NavigationQueryRequest) => store.readPage({ request: sent, scopeKey: "worktree", loadIndex: () => source.read() }));
      const window = new NavigationWindowQueries({ getNavigationQueryPage: read });
      try {
        window.setDemand(new Map([["projects", request], ["pins", pins]]));
        await window.refresh();
        const moved = "github.com/example/moved";
        for (const [originRepository, changesOrigin] of [[repositoryKey, false], [moved, true], [moved, false]] as const) {
          const gitStatus = { currentBranch: "feature", originRepository };
          mocks.store.readDirectoryGitStatusCache.mockResolvedValue({
            [repoKey]: { gitStatus: { currentBranch: "main" } }, [worktreeKey]: { gitStatus },
          });
          const event: AgentEvent = { backend: "codex", notification: { method: "navigation/directoryGitStatus/updated",
            params: { directoryKey: worktreeKey, fetchedAt: 1, gitStatus, directoryGitRevisions: navigationDirectoryGitRevisions(gitStatus) } } };
          for (const listener of source.listeners) listener(event);
          read.mockClear();
          window.invalidate(undefined, undefined, event);
          await window.refresh(undefined, undefined, true);
          const fresh = projectNavigationQuery({ index: await source.read(), request }).directories[0]!;
          expect(fresh.repositoryKey).toBe(parentRegistered ? repositoryKey : originRepository);
          expect(window.getSnapshot().resources.get("projects")!.state.page?.directories?.[0]?.repositoryKey).toBe(fresh.repositoryKey);
          expect(window.getSnapshot().resources.get("pins")!.state.page?.entries[0]?.row.checkoutProject?.repositoryKey).toBe(fresh.repositoryKey);
          expect(read.mock.calls.map(([sent]) => sent.query.kind).sort()).toEqual(
            changesOrigin && !parentRegistered ? ["directory-index", "group-members"] : [],
          );
        }
      } finally { window.dispose(); }
      if (parentRegistered) expect(projects[0]?.launchpadBackend).toBe("claude");
      const projectPage = (query: NavigationQueryRequest["query"]) => projectNavigationQuery({ index, request: {
        protocol: 2, inventory: "owner", consumer: "star-map", query,
      } });
      expect(projectPage({ kind: "star-map-geometry" }).directories).toMatchObject([{ key: repoKey, counts: { total: 1 } }]);
      expect(projectPage({ kind: "star-map", projectKey: repoKey, filters: {} }).entries.map(({ row }) => row)).toMatchObject([
        { id: thread.id, checkoutProject: { key: repoKey }, linkedDirectories: [{ path: worktree }] },
      ]);
      expect(projectPage({ kind: "star-map", projectKey: worktreeKey, filters: {} }).entries).toEqual([]);
    }
    const draftOnly = createSource();
    draftOnly.listThreads.mockResolvedValue([]);
    mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => ({ threads,
      directories: buildDirectorySummaries({ threads, launchpadsByKey: {
        [worktreeKey]: { ...launchpad(worktree, "codex"), registeredAt: undefined, prompt: "Unsent draft" },
      } }),
    }));
    expect((await draftOnly.read()).directories).toEqual([]);
  } finally {
    mocks.store.readNavigationQueryIndex.mockImplementation(previous!);
    mocks.store.readDirectoryGitStatusCache.mockResolvedValue({});
    await rm(root, { force: true, recursive: true });
  }
});

it("folds registered worktree rows only into the checkout Git identifies", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-separate-project-index-")));
  try {
    const primary = canonicalizeNavigationPath(path.join(root, "Project"));
    const worktree = canonicalizeNavigationPath(path.join(root, "tasks", "Project"));
    const other = canonicalizeNavigationPath(path.join(root, "other", "Project"));
    await runGitCommand(root, ["init", "--separate-git-dir", path.join(root, "admin"), primary]);
    await runGitCommand(primary, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"]);
    await runGitCommand(primary, ["worktree", "add", "--detach", worktree]);
    await runGitCommand(root, ["init", other]);
    const gitCommonDir = async (checkout: string) =>
      (await runGitCommand(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    expect(await gitCommonDir(worktree)).toBe(await gitCommonDir(primary));
    expect(await gitCommonDir(worktree)).not.toBe(await gitCommonDir(other));

    const row = (checkout: string) => ({
      key: `directory:${checkout}`, kind: "directory" as const, label: "Project", path: checkout,
      repositoryKey: "github.com/example/project", threadKeys: [], needsAttentionCount: 0,
    });
    const primaryRow = row(primary);
    const linkedRow = row(worktree);
    const otherRow = row(other);
    const { directories, worktreeProjectAliases } = await resolveNavigationWorktreeProjects(
      [linkedRow, otherRow, primaryRow], { threads: [] },
    );
    expect(directories.map(({ key }) => key).sort()).toEqual([primaryRow.key, otherRow.key].sort());
    expect(worktreeProjectAliases).toEqual({ [primaryRow.key]: [linkedRow.key] });
    expect((await resolveNavigationWorktreeProjects([linkedRow, otherRow], { threads: [] })).directories)
      .toEqual([linkedRow, otherRow]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("keeps the worktree path available when Git loses its primary checkout", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stale-worktree-")));
  try {
    const repo = path.join(root, "primary");
    const checkout = path.join(root, "linked");
    await runGitCommand(root, ["init", repo]);
    await runGitCommand(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"]);
    await runGitCommand(repo, ["worktree", "add", "--detach", checkout]);
    const probe = () => resolveWorktreeRepositoryDirectory(checkout, { rootOnly: true });
    expect(await probe()).toMatchObject({ path: canonicalizeNavigationPath(repo) });
    await rename(repo, path.join(root, "moved"));
    await expect(runGitCommand(checkout, ["rev-parse", "--show-toplevel"])).rejects.toThrow();
    expect(await probe()).toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

describe("owner index source event admission", () => {
  it.each([96, 192].flatMap((size) => [false, true].map((mounted) => ({ size, mounted }))))(
    "shares certified local launch rows for $size threads with an existing viewer mount: $mounted", async ({ size, mounted }) => {
      // Either inventory fits the pool. Two copies of the same 192 rows do not.
      const source = createSource();
      const threads = Array.from({ length: size }, (_, i): NavigationThreadSummary => ({
        id: `launch-${i}`, source: "codex", title: "x".repeat(26_000), titleSource: "explicit",
        createdAt: i, updatedAt: i, linkedDirectories: [], inbox: { inInbox: false },
      }));
      source.listThreads.mockResolvedValue(threads);
      const pin = { ...threads[0]!, id: "remote", federation: {
        instanceLabel: "Peer", ref: buildFederatedThreadRef({ backend: "codex", instanceId: "peer", threadId: "remote" }),
      } };
      const project = vi.fn(async (local: NavigationQueryIndex) => mounted ? appendViewerNavigationPins(local, [pin]) : local);
      const previous = mocks.store.readNavigationQueryIndex.getMockImplementation();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const viewer = { source: {}, project };
      const readViewer = () => loadLocalNavigationQueryIndex({ registry: source.registry, callerReason: "renderer-navigation-query", viewer });
      try {
        mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => ({ threads, directories: [] }));
        const before = await source.read();
        const child = { ...threads[0]!, id: "new-child", parentThreadId: threads[0]!.id };
        source.listThreads.mockResolvedValue([...threads, child]);
        source.emit("thread/started");
        const [owner, shown] = await Promise.all([source.read(), readViewer()]);
        expect(owner).not.toBe(before);
        expect(shown.threads[size]?.id).toBe(child.id);
        for (let i = 0; i < 3; i++) {
          await source.read();
          await readViewer();
        }
        expect({ physical: source.listThreads.mock.calls.length, projections: project.mock.calls.length,
          sharedRows: shown.threads[0] === owner.threads[0] }).toEqual({ physical: 2, projections: 1, sharedRows: true });
        expect(shown === owner).toBe(!mounted);
        if (mounted) {
          pin.title = "updated after publication";
          expect(shown.threads.at(-1)?.title).not.toBe(pin.title);
          expect(owner.threads).toHaveLength(size + 1);
        }
      } finally {
        source.emit("thread/name/updated");
        mocks.store.readNavigationQueryIndex.mockImplementation(previous!);
        vi.useRealTimers();
      }
    });

  it.each([
    { backend: "all", coverage: "complete", remembers: true },
    { backend: "codex", coverage: "complete", remembers: false },
    { backend: "all", coverage: "checking", remembers: false },
    { backend: "all", coverage: "degraded", remembers: false },
  ] as const)("publishes creation visibility before returning a $backend $coverage index", async ({ backend, coverage, remembers }) => {
    const source = createSource(coverage);
    source.finish();
    try {
      const index = await source.read(backend);
      if (remembers) expect(source.rememberNavigationVisibilityIndex).toHaveBeenCalledExactlyOnceWith(index);
      else expect(source.rememberNavigationVisibilityIndex).not.toHaveBeenCalled();
      if (backend === "all") expect(source.rememberDirectoryScope).toHaveBeenCalledExactlyOnceWith(index, 0);
      else expect(source.rememberDirectoryScope).not.toHaveBeenCalled();
    } finally {
      source.emit("thread/name/updated");
    }
  });

  it("keeps action-only indexes out of sidebar visibility and event scope", async () => {
    const source = createSource();
    source.finish();
    try {
      const visible = await source.read();
      await loadLocalNavigationQueryIndex({ registry: source.registry, callerReason: "remove-navigation-directory", requireVerifiedDirectories: true });
      expect(source.rememberNavigationVisibilityIndex).toHaveBeenCalledExactlyOnceWith(visible);
      expect(source.rememberDirectoryScope).toHaveBeenCalledExactlyOnceWith(visible, 0);
    } finally {
      source.emit("thread/name/updated");
    }
  });

  it("cannot grant directory scope from a scan overtaken at ingress before listeners hear the membership event", async () => {
    const source = createSource();
    const row: NavigationThreadSummary = { id: "hidden", source: "codex", title: "Hidden", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false } };
    const original = mocks.store.readNavigationQueryIndex.getMockImplementation();
    mocks.store.readNavigationQueryIndex.mockImplementation(() => ({ threads: [row], directories: [{
      key: "project", kind: "directory", label: "Project", threadKeys: ["codex:hidden"], needsAttentionCount: 0,
    }] }));
    const event = { backend: "codex", notification: { method: "thread/backgroundTasks/updated", params: { threadId: "hidden" } } } as AgentEvent;
    try {
      const pending = source.read();
      await Promise.resolve();
      source.navigationDirectoryScope.invalidate({ ...event,
        notification: { method: "navigation/threadDirectories/updated", params: {} } } as AgentEvent);
      source.finish(); await pending;
      expect(source.navigationDirectoryScope.forEvent(event)).toBeUndefined();
      source.emit("navigation/threadDirectories/updated");
      await source.read();
      expect(source.navigationDirectoryScope.forEvent(event)).toEqual({ version: 1, directoryKeys: ["project"] });
    } finally { source.emit("thread/name/updated"); mocks.store.readNavigationQueryIndex.mockImplementation(original!); }
  });

  it("shares pending index work across transcript-only events", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    source.emit("item/agentMessage/delta");
    source.emit("thread/tokenUsage/updated");
    const second = source.read();
    await Promise.resolve();
    source.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(await source.read()).toBe(a);
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    expect(source.listeners.size).toBe(1);
    source.emit("thread/name/updated");
    expect(source.listeners.size).toBe(0);
  });

  it("runs a provider refresh beside an in-flight read without costing it a retry", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    const refreshed = source.refresh();
    await Promise.resolve();
    source.finish();
    await Promise.all([first, refreshed]);
    // The refresh lists providers afresh; the read in flight finishes once.
    expect(source.listThreads.mock.calls.map(([params]) => Boolean(params?.forceRefresh)))
      .toEqual([false, true]);
  });

  it.each([
    { olderRefresh: false, olderFinishesLast: false },
    { olderRefresh: false, olderFinishesLast: true },
    { olderRefresh: true, olderFinishesLast: false },
    { olderRefresh: true, olderFinishesLast: true },
  ])("preserves the newest creation visibility across pool keys (older refresh: $olderRefresh, finishes last: $olderFinishesLast)", async ({ olderRefresh, olderFinishesLast }) => {
    const source = createSource();
    const pinned = { id: "pinned", source: "codex", title: "Pinned", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false }, pinnedRank: "1024" } as NavigationThreadSummary;
    const created = { ...pinned, id: "created", pinnedRank: "0" };
    let finishOlder!: (threads: NavigationThreadSummary[]) => void;
    let finishNewer!: (threads: NavigationThreadSummary[]) => void;
    source.listThreads.mockImplementationOnce(() => new Promise((resolve) => { finishOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNewer = resolve; }));
    const projection = mocks.store.readNavigationQueryIndex.getMockImplementation();
    mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => ({ threads, directories: [] }));
    const older = olderRefresh ? source.refresh() : source.read();
    const newer = olderRefresh ? source.read() : source.refresh();
    try {
      if (olderFinishesLast) {
        finishNewer([pinned, created]);
        await newer;
        finishOlder([pinned]);
        await older;
      } else {
        finishOlder([pinned]);
        await older;
        expect(source.rememberNavigationVisibilityIndex).not.toHaveBeenCalled();
        finishNewer([pinned, created]);
        await newer;
      }
      expect(source.rememberNavigationVisibilityIndex).toHaveBeenCalledExactlyOnceWith(await newer);
      const remembered = source.rememberNavigationVisibilityIndex.mock.calls.at(-1)![0] as NavigationQueryIndex;
      expect(remembered.threads.map((thread) => thread.id)).toEqual(["pinned", "created"]);
      // A stale completion must not discard the newly allocated rank and
      // let the following creation reuse it.
      expect(buildPrependPinRank(remembered.threads.map((thread) => thread.pinnedRank))).toBe("-1024");
      expect((await older).threads).toEqual([pinned]);
    } finally {
      finishOlder([pinned]); finishNewer([pinned, created]);
      await Promise.allSettled([older, newer]);
      mocks.store.readNavigationQueryIndex.mockImplementation(projection!);
      source.emit("thread/name/updated");
    }
  });

  it.each(["thread/pin/added", "thread/pin/removed", "directory/threadsCollapsed/updated"])("does not publish a scan overtaken by %s", async (method) => {
    const source = createSource();
    const pending = source.read();
    source.emit(method);
    source.finish();
    try {
      expect((await pending).coverage?.state).toBe("complete");
      expect(source.rememberNavigationVisibilityIndex).not.toHaveBeenCalled();
      const current = await source.read();
      expect(source.rememberNavigationVisibilityIndex).toHaveBeenCalledExactlyOnceWith(current);
    } finally {
      source.emit("thread/name/updated");
    }
  });

  it("does not publish a scan overtaken by an external source version change", async () => {
    const source = createSource();
    const pending = source.read();
    mocks.store.readNavigationSourceVersion.mockReturnValue("external-pin-change");
    source.finish();
    try {
      await pending;
      expect(source.rememberNavigationVisibilityIndex).not.toHaveBeenCalled();
      const current = await source.read();
      expect(source.rememberNavigationVisibilityIndex).toHaveBeenCalledExactlyOnceWith(current);
    } finally {
      mocks.store.readNavigationSourceVersion.mockReturnValue("unchanged");
      source.emit("thread/name/updated");
    }
  });

  it("does not restart an index for a subagent event with unchanged navigation", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    const event = { backend: "codex", notification: { method: "thread/subAgents/updated",
      params: { threadId: "thread", navigationChanged: false } } } as AgentEvent;
    for (const listener of source.listeners) listener(event);
    const second = source.read();
    source.finish();
    expect(await second).toBe(await first);
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    source.emit("thread/name/updated");
  });

  it("keeps repeated unchanged reads stable, but refreshes after a durable source version change", async () => {
    const source = createSource();
    source.finish();
    try {
      const first = await source.read();
      for (let index = 0; index < 20; index++) expect(await source.read()).toBe(first);
      expect(source.listThreads).toHaveBeenCalledTimes(1);
      mocks.store.readNavigationSourceVersion.mockReturnValue("external-change");
      const changed = await source.read();
      expect(changed).not.toBe(first);
      expect(source.listThreads).toHaveBeenCalledTimes(2);
      expect(await source.read()).toBe(changed);
    } finally {
      mocks.store.readNavigationSourceVersion.mockReturnValue("unchanged");
      source.emit("thread/name/updated");
    }
  });

  it("shares one replacement across durable revisions while an owner scan is pending", async () => {
    const source = createSource();
    const reads = [source.read()];
    try {
      await Promise.resolve();
      for (let revision = 1; revision <= 12; revision++) {
        mocks.store.readNavigationSourceVersion.mockReturnValue(`revision-${revision}`);
        const read = source.read();
        void read.catch(() => undefined);
        reads.push(read);
        await Promise.resolve();
      }
      source.finish();
      const results = await Promise.allSettled(reads);
      expect(results).toEqual(reads.map(() => expect.objectContaining({ status: "fulfilled" })));
      expect(source.listThreads).toHaveBeenCalledTimes(2);
      const first = await reads[0];
      for (const read of reads) expect(await read).toBe(first);
      expect(await source.read()).toBe(first);
      expect(source.listThreads).toHaveBeenCalledTimes(2);
      expect(source.listeners.size).toBe(1);
    } finally {
      source.finish();
      mocks.store.readNavigationSourceVersion.mockReturnValue("unchanged");
      source.emit("thread/name/updated");
      await Promise.allSettled(reads);
    }
    expect(source.listeners.size).toBe(0);
  });

  it("does not share owner work across registries or provider scopes", async () => {
    const first = createSource();
    const second = createSource();
    first.finish(); second.finish();
    try {
      await Promise.all([first.read(), first.read("codex"), second.read()]);
      expect(first.listThreads).toHaveBeenCalledTimes(2);
      expect(second.listThreads).toHaveBeenCalledTimes(1);
      expect(first.rememberNavigationVisibilityIndex).toHaveBeenCalledTimes(1);
      expect(second.rememberNavigationVisibilityIndex).toHaveBeenCalledTimes(1);
      await Promise.all([first.read(), first.read("codex"), second.read()]);
      expect(first.listThreads).toHaveBeenCalledTimes(2);
      expect(second.listThreads).toHaveBeenCalledTimes(1);
    } finally {
      first.emit("thread/name/updated"); second.emit("thread/name/updated");
    }
  });

  it("starts fresh owner work after a canonical navigation event", async () => {
    const source = createSource();
    const first = source.read();
    await Promise.resolve();
    source.emit("thread/name/updated");
    const second = source.read();
    await Promise.resolve();
    source.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(source.listThreads).toHaveBeenCalledTimes(2);
    expect(a).toBe(b);
    expect(source.listeners.size).toBe(1);
    source.emit("thread/name/updated");
    expect(source.listeners.size).toBe(0);
  });

  it("carries each thread's active messaging bindings on its index row", async () => {
    // The sidebar's binding chips and Unbind menu items read the row. Before
    // this, only the selected thread's detail read had bindings, so a bound
    // thread showed no chip and no Unbind control unless it was selected.
    const row = (id: string, source: NavigationThreadSummary["source"] = "codex"): NavigationThreadSummary => ({
      id, source, title: id, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    });
    const binding = (id: string, threadId: string, extra: Partial<MessagingBindingRecord> = {}): MessagingBindingRecord => ({
      id, threadId, backend: "codex", authorizedActorIds: [], createdAt: 1, updatedAt: 2,
      channel: { channel: "telegram", conversation: { kind: "topic", id: `${id}-topic`, title: "Grid work",
        parentTitle: "M5 Group" } },
      ...extra,
    } as MessagingBindingRecord);
    const remote = { ...row("remote-bound"), federation: { ref: { target: { scope: "remote", instanceId: "peer" },
      backend: "codex", threadId: "remote-bound" }, instanceLabel: "Peer" } } as NavigationThreadSummary;
    const original = mocks.store.readNavigationQueryIndex.getMockImplementation();
    mocks.store.readNavigationQueryIndex.mockImplementation(() => ({
      threads: [row("bound"), row("unbound"), row("other-backend", "claude"), remote], directories: [],
    }));
    mocks.messaging.findActiveBindings.mockResolvedValue([
      // The store lists by updated_at DESC; a status render bumps it. Chips
      // must stay in creation order rather than trade places.
      binding("binding-0", "bound", { createdAt: 5, updatedAt: 9,
        channel: { channel: "slack", conversation: { kind: "channel", id: "c", title: "ops" } } } as Partial<MessagingBindingRecord>),
      binding("binding-1", "bound"),
      // A binding for the same id on another backend belongs to that thread.
      binding("binding-2", "other-backend", { backend: "codex" }),
      // A remote row is the peer's thread; this machine's bindings never attach.
      binding("binding-3", "remote-bound"),
    ]);
    const source = createSource();
    source.finish();
    try {
      const index = await source.read();
      const byId = new Map(index.threads.map((thread) => [thread.id, thread]));
      expect(byId.get("bound")?.messagingBindings).toEqual([{
        bindingId: "binding-1", platform: "telegram", conversationKind: "topic",
        conversationTitle: "Grid work", parentTitle: "M5 Group", ancestorTitle: undefined, activeAt: 2,
      }, expect.objectContaining({ bindingId: "binding-0", platform: "slack", activeAt: 9 })]);
      expect(byId.get("unbound")?.messagingBindings).toBeUndefined();
      expect(byId.get("other-backend")?.messagingBindings).toBeUndefined();
      expect(byId.get("remote-bound")?.messagingBindings).toBeUndefined();
      expect(mocks.messaging.findActiveBindings).toHaveBeenCalledTimes(1);
    } finally {
      mocks.store.readNavigationQueryIndex.mockImplementation(original!);
      mocks.messaging.findActiveBindings.mockResolvedValue([]);
      mocks.messaging.findActiveBindings.mockClear();
      source.emit("thread/name/updated");
    }
  });

  it("marks each local row's CI watches from one read, and leaves a peer's row its owner's marks", async () => {
    const row = (id: string): NavigationThreadSummary => ({
      id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    });
    const ownerMarks = [{ prKey: "github.com/a/b#2", watchId: "owner-ci", notifyOn: ["failure" as const], createdAt: 3 }];
    const remote = { ...row("watched"), prCiWatches: ownerMarks, federation: { ref: { target: { scope: "remote", instanceId: "peer" },
      backend: "codex", threadId: "watched" }, instanceLabel: "Peer" } } as NavigationThreadSummary;
    const watch = (watchId: string, threadId: string, extra: Partial<ThreadPullRequestWatchSummary> = {}): ThreadPullRequestWatchSummary => ({
      watchId, backend: "codex", threadId, prKey: "github.com/a/b#1", prUrl: "https://github.com/a/b/pull/1", prNumber: 1,
      headSha: "a".repeat(40), notifyOn: ["success", "failure"], createdAt: 1, failureHandledByAutoFix: false, kind: "checks",
      ...extra,
    });
    const original = mocks.store.readNavigationQueryIndex.getMockImplementation();
    mocks.store.readNavigationQueryIndex.mockImplementation(() => ({
      threads: [row("watched"), row("merge-only"), remote], directories: [],
    }));
    mocks.store.listAllActivePrStatusWatches.mockResolvedValue([
      // A re-run's attempt survives on the baseline of an older row.
      watch("ci", "watched", { baseline: { outcome: "failure", observedAt: 1, runAttempt: 2 } }),
      // A merge/close watch draws no eye.
      watch("merge", "merge-only", { kind: "terminal", notifyOn: ["merged", "closed"] }),
    ]);
    const source = createSource();
    source.finish();
    try {
      const index = await source.read();
      const local = index.threads.filter((thread) => !thread.federation);
      expect(local.find((thread) => thread.id === "watched")?.prCiWatches).toEqual([{
        prKey: "github.com/a/b#1", watchId: "ci", notifyOn: ["success", "failure"], createdAt: 1, runAttempt: 2,
      }]);
      expect(local.find((thread) => thread.id === "merge-only")?.prCiWatches).toBeUndefined();
      // Pool snapshots detach even peer-owned metadata before certification.
      const peerMarks = index.threads.find((thread) => thread.federation)?.prCiWatches;
      expect(peerMarks).toEqual(ownerMarks);
      expect(peerMarks).not.toBe(ownerMarks);
      expect(mocks.store.listAllActivePrStatusWatches).toHaveBeenCalledTimes(1);

      // A failed read serves the rows without marks.
      mocks.store.listAllActivePrStatusWatches.mockRejectedValueOnce(new Error("state is closing"));
      source.emit("thread/prWatches/updated");
      const degraded = await source.read();
      expect(degraded.threads.filter((thread) => !thread.federation).map((thread) => thread.prCiWatches))
        .toEqual([undefined, undefined]);
    } finally {
      mocks.store.readNavigationQueryIndex.mockImplementation(original!);
      mocks.store.listAllActivePrStatusWatches.mockResolvedValue([]);
      mocks.store.listAllActivePrStatusWatches.mockClear();
      source.emit("thread/name/updated");
    }
  });

  it("shares one replacement scan across consumers admitted between related events", async () => {
    const source = createSource();
    const reads = [source.read()];
    await Promise.resolve();
    for (const method of ["turn/started", "thread/status/changed", "thread/subAgents/updated", "navigation/thread/seen"]) {
      source.emit(method);
      reads.push(source.read());
      await Promise.resolve();
    }
    source.finish();
    const results = await Promise.all(reads);
    expect(source.listThreads).toHaveBeenCalledTimes(2);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(source.listeners.size).toBe(1);
    source.emit("thread/name/updated");
    expect(source.listeners.size).toBe(0);
  });
});

describe("owner index reads under live turns", () => {
  it("finishes the scan it started while row events keep landing", async () => {
    // Each scan stays open until the test has emitted its events, the way a
    // busy owner's live turns land while a slow listing is in flight. The
    // pool used to restart for each one and failed the third time with
    // "Navigation changed repeatedly during its owner index read".
    const scans: Array<() => void> = [];
    const listeners = new Set<(event: AgentEvent) => void>();
    const listThreads = vi.fn(() => new Promise<[]>((resolve) => { scans.push(() => resolve([])); }));
    const registry = {
      listThreads,
      onEvent: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      withNavigationPrimaryGitRepositories: (threads: []) => threads,
      hydrateThreadGitWorkingStates: async (threads: []) => threads,
      withNavigationSubAgentActivity: (threads: []) => threads,
      getNavigationInputRequestThreadKeys: () => new Set<string>(),
    } as unknown as DesktopBackendRegistry;
    const emit = (method: string) => {
      const event = { backend: "codex", notification: { method, params: { threadId: "thread" } } } as AgentEvent;
      for (const listener of listeners) listener(event);
    };
    let settled = false;
    const read = loadLocalNavigationQueryIndex({ registry, callerReason: "thread-todo-owners" })
      .finally(() => { settled = true; });
    for (let scan = 1; scan <= 3 && !settled; scan += 1) {
      await vi.waitFor(() => expect(scans.length).toBe(1));
      emit("turn/started");
      emit("thread/status/changed");
      emit("thread/archived");
      scans.shift()!();
      await vi.waitFor(() => expect(settled || scans.length === 1).toBe(true));
    }
    await expect(read).resolves.toMatchObject({ threads: [] });
    expect(listThreads).toHaveBeenCalledTimes(1);
    // An overtaken scan is not reused, so it holds no listener afterwards.
    await vi.waitFor(() => expect(listeners.size).toBe(0));
  });

  it("stamps each scan as it begins, and a reused index keeps the stamp of the listing it holds", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const listThreads = vi.fn(async () => []);
    const registry = {
      listThreads,
      onEvent: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      withNavigationPrimaryGitRepositories: (threads: []) => threads,
      hydrateThreadGitWorkingStates: async (threads: []) => threads,
      withNavigationSubAgentActivity: (threads: []) => threads,
      getNavigationInputRequestThreadKeys: () => new Set<string>(),
    } as unknown as DesktopBackendRegistry;
    const load = () => loadLocalNavigationQueryIndex({ registry, callerReason: "observation-stamp" });
    const first = await load();
    expect(first.observedAt).toEqual(expect.any(Number));
    const reused = await load();
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(reused.observedAt).toBe(first.observedAt);
    for (const listener of listeners) {
      listener({ backend: "codex", notification: { method: "thread/archived", params: { threadId: "thread" } } } as AgentEvent);
    }
    const next = await load();
    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(next.observedAt).toBeGreaterThan(first.observedAt!);
    for (const listener of listeners) {
      listener({ backend: "codex", notification: { method: "thread/archived", params: { threadId: "thread" } } } as AgentEvent);
    }
  });
});

it.each([
  ["Inbox lens", { kind: "lens", lens: "inbox" }],
  ["selected thread's exact row", { kind: "exact", identities: [{ backend: "codex", threadId: "bound" }] }],
] as const)("serves a bound thread's bindings on its %s page row", async (_scenario, query) => {
  // The sidebar row, selected or not, renders from these pages alone; the
  // selected-detail read feeds the composer and detail pane, never the row.
  const thread: NavigationThreadSummary = { id: "bound", source: "codex", title: "Electric grid",
    titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true } };
  const registry = {
    listThreads: async () => [thread],
    onEvent: () => () => undefined,
    withNavigationPrimaryGitRepositories: (threads: NavigationThreadSummary[]) => threads,
    hydrateThreadGitWorkingStates: async (threads: NavigationThreadSummary[]) => threads,
    withNavigationSubAgentActivity: (threads: NavigationThreadSummary[]) => threads,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
  } as unknown as DesktopBackendRegistry;
  const original = mocks.store.readNavigationQueryIndex.getMockImplementation();
  mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => ({ threads, directories: [] }));
  mocks.messaging.findActiveBindings.mockResolvedValue([{
    id: "binding-1", threadId: "bound", backend: "codex", authorizedActorIds: [], createdAt: 1, updatedAt: 2,
    channel: { channel: "telegram", conversation: { kind: "topic", id: "topic", title: "Electric grid" } },
  } as MessagingBindingRecord]);
  try {
    const request = { protocol: 2, consumer: "main-sidebar", query } as NavigationQueryRequest;
    const page = await new NavigationQueryStore().readPage({
      request, scopeKey: "renderer-local",
      loadIndex: () => loadLocalNavigationQueryIndex({ registry, callerReason: "renderer-navigation-query" }),
    });
    const row = page.entries.find((entry) => entry.row.id === "bound")?.row;
    expect(row?.messagingBindings).toEqual([expect.objectContaining({
      bindingId: "binding-1", platform: "telegram", conversationTitle: "Electric grid",
    })]);
  } finally {
    mocks.store.readNavigationQueryIndex.mockImplementation(original!);
    mocks.messaging.findActiveBindings.mockResolvedValue([]);
  }
});

it.each([
  ["title change", ["thread/name/updated"]],
  ["pin action", ["thread/pin/added"]],
  ["mark seen", ["navigation/thread/seen"]],
  ["turn start", ["turn/started", "thread/status/changed", "thread/subAgents/updated"]],
])("bounds physical listing work for %s across directory, children and exact consumers", async (_scenario, methods) => {
  const originalProjection = mocks.store.readNavigationQueryIndex.getMockImplementation();
  mocks.store.readNavigationQueryIndex.mockClear();
  const parent: NavigationThreadSummary = { id: "parent", source: "codex", title: "before", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false } };
  let current = parent;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  const listeners = new Set<(event: AgentEvent) => void>();
  const rpc = vi.fn();
  const listThreads = vi.fn(async () => {
    const snapshot = current;
    for (let page = 1; page <= 3; page++) {
      rpc(page);
      if (listThreads.mock.calls.length === 1 && page === 1) {
        firstStarted();
        await firstGate;
      }
    }
    return [snapshot];
  });
  const registry = {
    listThreads,
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    withNavigationPrimaryGitRepositories: (threads: NavigationThreadSummary[]) => threads,
    hydrateThreadGitWorkingStates: async (threads: NavigationThreadSummary[]) => threads,
    withNavigationSubAgentActivity: (threads: NavigationThreadSummary[]) => threads,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
  } as unknown as DesktopBackendRegistry;
  mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => ({ threads, directories: [] }));
  const pool = new NavigationQueryPool();
  const store = new NavigationQueryStore();
  const requests: NavigationQueryRequest[] = [
    { protocol: 2, consumer: "main-sidebar", query: { kind: "directory", directoryKey: "project" } },
    { protocol: 2, consumer: "main-sidebar", query: { kind: "children", parent: { backend: "codex", threadId: "parent" } } },
    { protocol: 2, consumer: "main-sidebar", query: { kind: "exact", identities: [{ backend: "codex", threadId: "parent" }] } },
    { protocol: 2, consumer: "main-sidebar", query: { kind: "directory", directoryKey: "project" } },
  ];
  const read = (index: number) => pool.read({
    consumerId: `sidebar-${index}`,
    request: requests[index]!,
    load: ({ signal }) => store.readPage({
      request: requests[index]!, scopeKey: "renderer-local",
      loadIndex: () => loadLocalNavigationQueryIndex({ registry, callerReason: "renderer-navigation-query", signal }),
    }),
  });
  const emit = (method: string) => {
    const event = { backend: "codex", notification: { method, params: { threadId: "parent" } } } as AgentEvent;
    for (const listener of listeners) listener(event);
    store.observeAttentionEvent(event);
    pool.invalidateQueryOwner();
  };
  try {
    const pending = [read(0)];
    await firstStart;
    current = { ...parent, title: "after", threadStatus: "active" };
    for (const [index, method] of methods.entries()) {
      emit(method);
      pending.push(read(index + 1));
      await Promise.resolve();
    }
    for (let index = pending.length; index < requests.length; index++) pending.push(read(index));
    releaseFirst();
    const pages = await Promise.all(pending);
    expect(pages[2]!.entries[0]?.row.title).toBe("after");
    expect({ logicalRequests: pending.length, indexConstructions: mocks.store.readNavigationQueryIndex.mock.calls.length,
      providerListings: listThreads.mock.calls.length, paginatedRpcs: rpc.mock.calls.length, pagesPerListing: 3 })
      .toEqual(budgets["turn-start-with-related-notifications"]);
    const rerender = await Promise.all(requests.map((_, index) => read(index)));
    expect(rerender[2]!.entries[0]?.row.title).toBe("after");
    expect({ logicalRequests: rerender.length, indexConstructions: mocks.store.readNavigationQueryIndex.mock.calls.length,
      providerListings: listThreads.mock.calls.length, paginatedRpcs: rpc.mock.calls.length, pagesPerListing: 3 })
      .toEqual(budgets["unchanged-rerender"]);
    current = { ...current, title: "later" };
    emit("thread/name/updated");
    const later = await read(2);
    expect(later.entries[0]?.row.title).toBe("later");
    expect({ logicalRequests: 1, indexConstructions: mocks.store.readNavigationQueryIndex.mock.calls.length,
      providerListings: listThreads.mock.calls.length, paginatedRpcs: rpc.mock.calls.length, pagesPerListing: 3 })
      .toEqual(budgets["later-mutation"]);
  } finally {
    releaseFirst();
    for (let index = 0; index < requests.length; index++) pool.release(`sidebar-${index}`);
    mocks.store.readNavigationQueryIndex.mockImplementation(originalProjection!);
  }
});

describe("owner index coverage", () => {
  function readCoverage(params: {
    startup?: { state: "checking" | "degraded" | "ready"; failedProviders?: number };
    incomplete: boolean;
  }) {
    const listed: NavigationThreadSummary[] = [];
    const registry = {
      listThreads: async () => listed,
      isIncompleteThreadList: (threads: unknown) => params.incomplete && threads === listed,
      getStartupProviderRefreshStatus: () => params.startup,
      onEvent: () => () => {},
      withNavigationPrimaryGitRepositories: (threads: []) => threads,
      hydrateThreadGitWorkingStates: async (threads: []) => threads,
      withNavigationSubAgentActivity: (threads: []) => threads,
      getNavigationInputRequestThreadKeys: () => new Set<string>(),
    } as unknown as DesktopBackendRegistry;
    return loadLocalNavigationQueryIndex({ registry, callerReason: "coverage-regression" })
      .then((index) => index.coverage);
  }

  it("completes an index built from a complete listing after a degraded startup", async () => {
    // A Claude or ACP discovery failure at startup, or a Codex failure that has
    // since recovered, must not block group archive for the whole session.
    await expect(readCoverage({ startup: { state: "degraded", failedProviders: 2 }, incomplete: false }))
      .resolves.toEqual({ state: "complete" });
  });

  it("degrades an index whose listing stood in an empty Codex inventory after a ready startup", async () => {
    await expect(readCoverage({ startup: { state: "ready" }, incomplete: true }))
      .resolves.toEqual({ state: "degraded", failedProviders: 1 });
  });

  it("keeps an index checking until the startup provider refresh settles", async () => {
    await expect(readCoverage({ startup: { state: "checking" }, incomplete: false }))
      .resolves.toEqual({ state: "checking" });
  });

  it("does not serve an index built while startup was checking once startup finishes", async () => {
    // Owner PR metadata reads the index from the refreshed event's first
    // listener, before the read pool's own listener can invalidate it.
    // Serving the retained checking index then left Auto-fix with no
    // candidates for the session.
    let startup: { state: "checking" | "ready" } = { state: "checking" };
    const listThreads = vi.fn(async (): Promise<NavigationThreadSummary[]> => []);
    const registry = {
      listThreads,
      isIncompleteThreadList: () => false,
      getStartupProviderRefreshStatus: () => startup,
      onEvent: () => () => {},
      withNavigationPrimaryGitRepositories: (threads: []) => threads,
      hydrateThreadGitWorkingStates: async (threads: []) => threads,
      withNavigationSubAgentActivity: (threads: []) => threads,
      getNavigationInputRequestThreadKeys: () => new Set<string>(),
    } as unknown as DesktopBackendRegistry;
    const read = () => loadLocalNavigationQueryIndex({ registry, callerReason: "coverage-regression" });

    expect((await read()).coverage).toEqual({ state: "checking" });
    expect((await read()).coverage).toEqual({ state: "checking" });
    expect(listThreads).toHaveBeenCalledTimes(1);
    startup = { state: "ready" };
    expect((await read()).coverage).toEqual({ state: "complete" });
    expect(listThreads).toHaveBeenCalledTimes(2);
  });
});

it("keeps confirmed stack badges for unchanged rows while Git revalidates", async () => {
  const source = createSource();
  const row: NavigationThreadSummary = {
    id: "stacked", source: "codex", title: "Stacked", titleSource: "explicit", gitBranch: "topic",
    linkedDirectories: [{ id: "/fixture/stack", kind: "local", path: "/fixture/stack", label: "Stack" }],
    inbox: { inInbox: false },
  };
  const initial: StackSummary = { key: "stack", name: "Stack", trunk: "main", inferred: false,
    repository: "github.com:fixture/stack", layers: [{
      role: "layer", branch: "topic", parent: "main", health: "in_sync", thread: { key: "codex:stacked", title: "Stacked" },
    }] };
  source.listThreads.mockResolvedValue([row]);
  source.registry.publishLocalEvent = vi.fn(async () => {});
  const projection = mocks.store.readNavigationQueryIndex;
  const original = projection.getMockImplementation()!;
  projection.mockImplementation(({ threads }) => ({ ...mocks.store.readNavigationQueryThreads({ threads }), directories: [] }));
  const nextScan = Promise.withResolvers<void>();
  const git = vi.spyOn(StackReader.prototype, "read").mockResolvedValueOnce({ stacks: [initial], catalogs: [] })
    .mockImplementation(async () => { await nextScan.promise; return { stacks: [], catalogs: [] }; });
  const read = () => loadSidebarNavigationQueryIndex({ registry: source.registry, includeStacks: true, callerReason: "renderer-navigation-query" });
  const badges = async () => (await read()).threads[0]?.stackMemberships;
  try {
    await read();
    await vi.waitFor(async () => expect(await badges()).toEqual([expect.objectContaining({ key: "stack" })]));
    vi.mocked(getDesktopBackendRegistry).mockReturnValue(source.registry);
    expect((await readNavigationStackLayers({ backend: "codex", threadId: "stacked" })).count).toBe(1);
    expect(git).toHaveBeenCalledTimes(1);
    source.emit("turn/started");
    expect(await badges()).toEqual([expect.objectContaining({ key: "stack" })]);
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(2));
    nextScan.resolve();
    await vi.waitFor(async () => expect(await badges()).toBeUndefined());
  } finally {
    nextScan.resolve();
    vi.mocked(getDesktopBackendRegistry).mockReset();
    git.mockRestore();
    projection.mockImplementation(original);
    source.emit("thread/name/updated");
  }
});

it.each([8, 16, 32])("reuses checkout verdicts when one PR changes across %i mounted lists", async (count) => {
  const source = createSource();
  const verify = vi.fn<DesktopBackendRegistry["canonicalizeNavigationPullRequests"]>(async (prs) => prs);
  source.registry.canonicalizeNavigationPullRequests = verify;
  const batches = Array.from({ length: count }, (_, i): PrSummary[] => [{ number: i + 1, provider: "github.com", org: "fixture", repo: "project",
    headRefName: "topic", linkedDirectoryPaths: ["/fixture"], state: "pending", url: "https://github.com/fixture/project/pull/" + (i + 1) }]);
  const page = navigationPullRequestProjection({ kind: "directory", registry: source.registry, backgroundValidation: true });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await page.verify(batches);
  await settle();
  const pr: PrSummary = { ...batches[0]![0]!, state: "passing" };
  verify.mockClear().mockImplementation(async (rows) => rows.map((row) => row.number === 1 ? pr : row));
  for (const listener of source.listeners) listener({ backend: "codex", notification: {
    method: "pullRequest/status/updated", params: { pr, prKey: buildPullRequestStatusKey(pr) },
  } });
  await page.verify(batches);
  await settle();
  expect((await page.verify(batches))[0]).toEqual([pr]);
  expect(verify.mock.calls.map(([rows, , checkout]) => [rows[0]?.number, checkout])).toEqual([[1, false]]);
  verify.mockClear();
  await page.verify([[pr]]);
  await settle();
  expect((await page.verify([[pr]]))[0]).toEqual([pr]);
  expect(verify.mock.calls.filter(([, , checkout]) => checkout !== false)).toHaveLength(0);
  const moved = { ...pr, headRefName: "new-topic" };
  verify.mockClear().mockImplementation(async (rows, _demand, checkout) => checkout === false ? rows : []);
  await page.verify([[moved]]);
  await settle();
  expect((await page.verify([[moved]]))[0]).toEqual([]);
  expect(verify.mock.calls.filter(([, , checkout]) => checkout !== false)).toHaveLength(1);
});

it.each(["owner", "viewer"] as const)("releases a cancelled sidebar %s waiter while another reader completes", async (stage) => {
  const source = createSource();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const prepare = vi.fn(async () => { entered.resolve(); await gate.promise; return (owner: NavigationQueryIndex) => owner; });
  source.listThreads.mockImplementation(async () => { if (stage === "owner") { entered.resolve(); await gate.promise; } return []; });
  const read = (signal?: AbortSignal) => loadSidebarNavigationQueryIndex({ registry: source.registry, callerReason: "cancelled-page",
    viewerPins: { source, prepare }, signal });
  const cancel = new AbortController();
  const first = read(cancel.signal);
  const second = read();
  try {
    await entered.promise;
    cancel.abort(new Error("closed"));
    const result = await Promise.race([first.catch((error: Error) => error.message), new Promise<void>((done) => setImmediate(done))]);
    expect(result).toBe("closed");
  } finally { gate.resolve(); await Promise.allSettled([first, second]); }
  expect(source.listThreads).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledTimes(1);
});

it("keeps rejected automatic PRs hidden across sidebar cache pressure", async () => {
  const { registry } = createSource();
  registry.publishLocalEvent = vi.fn(async () => {});
  const verifyAttachments = vi.fn<DesktopBackendRegistry["canonicalizeNavigationPullRequests"]>(
    async (prs, _demand, verify) => verify === false ? prs : [],
  );
  registry.canonicalizeNavigationPullRequests = verifyAttachments;
  const projection = navigationPullRequestProjection({ kind: "directory", registry, backgroundValidation: true });
  const batches = Array.from({ length: 257 }, (_, index): PrSummary[] => [{
    number: index + 1, provider: "github.com", org: "fixture", repo: "project", state: "passing",
    url: `https://github.com/fixture/project/pull/${index + 1}`, linkedDirectoryPaths: ["/fixture/project"], headRefName: "main",
  }]);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await projection.verify(batches.slice(0, 256));
    await settle();
    expect(await projection.verify(batches.slice(256))).toEqual([[]]);
    clock.mockReturnValue(now + 60_001);
    await projection.verify(batches.slice(256));
    await settle();
    // A cache miss may require fresh proof. It cannot turn a failed
    // attachment into a visible chip, or publish a refresh for rejecting it again.
    expect(await projection.verify(batches.slice(0, 1))).toEqual([[]]);
    await settle();
    expect(verifyAttachments.mock.calls.filter(([prs, , verify]) => prs[0]?.number === 1 && verify !== false)).toHaveLength(2);
    expect(registry.publishLocalEvent).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

it("reuses membership across a PR status burst while pages observe the current registry", async () => {
  const source = createSource();
  const project = mocks.store.readNavigationQueryIndex;
  const original = project.getMockImplementation()!;
  const pr = { provider: "github.com", org: "fixture", repo: "work", number: 23,
    url: "https://github.com/fixture/work/pull/23", state: "pending" } as const;
  const threads = Array.from({ length: 800 }, (_, index): NavigationThreadSummary => ({
    source: "codex", id: `fixture-${index}`, title: `Thread ${index}`, titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: true }, ...(index === 0 ? { prs: [pr] } : {}),
  }));
  source.listThreads.mockResolvedValue(threads);
  vi.spyOn(source.registry, "withNavigationPrimaryGitRepositories").mockImplementation((rows) => rows.map((row) => ({
    ...row, primaryGitRepository: "github.com/fixture/work",
  })));
  project.mockClear().mockImplementation(({ threads }) => ({ threads, directories: [] }));
  source.finish();
  const store = new NavigationQueryStore();
  const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar",
    query: { kind: "exact", identities: [{ backend: "codex", threadId: "fixture-0" }, { backend: "codex", threadId: "fixture-1" }] } };
  let status: NonNullable<NavigationThreadSummary["prs"]>[number] = pr;
  const read = () => store.readPage({ request, scopeKey: "fixture", loadIndex: () => source.read(),
    pullRequests: { read: async () => [[status]], verify: async () => [[status]] } });
  try {
    const initial = await read();
    expect(initial.entries[0]?.row.prs?.[0]?.state).toBe("pending");
    expect(initial.entries[1]?.row).toMatchObject({ id: "fixture-1", primaryGitRepository: "github.com/fixture/work" });
    for (const state of ["failing", "passing", "merged"] as const) {
      status = { ...pr, state };
      source.emit("pullRequest/status/updated");
      expect((await read()).entries[0]?.row.prs?.[0]?.state).toBe(state);
    }
    expect(source.listThreads).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledTimes(1);
  } finally {
    project.mockImplementation(original);
    source.emit("thread/name/updated");
  }
});

type NavigationStackSource = {
  source: ReturnType<typeof createSource>;
  read: (viewer?: { source: object; project: (index: NavigationQueryIndex) => Promise<NavigationQueryIndex> }) => Promise<NavigationQueryIndex>;
  viewer: { source: object; project: (index: NavigationQueryIndex) => Promise<NavigationQueryIndex> };
};

async function withNavigationStackSource(root: string, run: (fixture: NavigationStackSource) => Promise<void>) {
  const source = createSource();
  source.registry.stackThreadHeld = () => true;
  const original = mocks.store.readNavigationQueryIndex.getMockImplementation()!;
  try {
    source.listThreads.mockImplementation(async () => [{
      id: "stacked", source: "codex", title: "Stacked", titleSource: "explicit",
      gitBranch: "topic", linkedDirectories: [{ id: root, path: root, kind: "local", label: "Fixture" }],
      inbox: { inInbox: false },
    }]);
    mocks.store.readNavigationQueryIndex.mockImplementation(({ threads }) => ({ threads, directories: [] }));
    const pin: NavigationThreadSummary = {
      id: "remote", source: "codex", title: "Viewer pin", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false }, federation: { instanceLabel: "Peer",
        ref: buildFederatedThreadRef({ backend: "codex", threadId: "remote", instanceId: "peer" }) },
    };
    const viewer = { source: {}, project: async (index: NavigationQueryIndex) => appendViewerNavigationPins(index, [pin]) };
    const read = (view?: typeof viewer) => loadLocalNavigationQueryIndex({
      registry: source.registry, callerReason: "renderer-navigation-query", includeStacks: true, viewer: view,
    });
    await run({ source, read, viewer });
  } finally {
    source.emit("thread/name/updated");
    mocks.store.readNavigationQueryIndex.mockImplementation(original);
  }
}

async function withNavigationStackCheckout(run: (fixture: NavigationStackSource & {
  retargetCatalog: () => Promise<void>;
}) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-nav-stack-work-")));
  const restore = isolateProcessGitEnvironment(root);
  try {
    const git = async (...args: string[]) => (await runIsolatedGit(root, args)).stdout.trim();
    await git("init", "-b", "topic");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture");
    const head = await git("rev-parse", "HEAD");
    await git("branch", "main");
    const writeCatalog = (branch: string, commit: string) => writeFile(path.join(root, ".git", "gh-stack"), JSON.stringify({
      schemaVersion: 1, repository: "github.com:fixture/stack",
      stacks: [{ trunk: { branch: "main", head }, branches: [{ branch, head: commit, base: head }] }],
    }));
    await writeCatalog("topic", head);
    await withNavigationStackSource(root, (fixture) => run({ ...fixture, retargetCatalog: async () => {
      await git("branch", "other-topic");
      const next = await git("rev-parse", "refs/heads/other-topic");
      await writeCatalog("other-topic", next);
    } }));
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

it("shares one live stack observation across concurrent owner and viewer inventory refreshes", async () => {
  await withNavigationStackCheckout(async ({ source, read, viewer }) => {
    const stackReads = vi.spyOn(StackReader.prototype, "read");
    try {
      for (const method of ["thread/name/updated", "pullRequest/status/updated", "turn/completed"]) {
        source.emit(method);
        const [owner, shown] = await Promise.all([read(), read(viewer)]);
        expect(owner.threads).toHaveLength(1);
        expect(shown.threads).toHaveLength(2);
        expect(owner.stacks?.length).toBe(1);
        expect(shown.stacks?.length).toBe(1);
      }
      expect(stackReads).toHaveBeenCalledTimes(3);
    } finally {
      stackReads.mockRestore();
    }
  });
});

it("keeps the viewer listing when publishing pins advances the durable navigation version", async () => {
  await withNavigationStackCheckout(async ({ source, read, viewer }) => {
    const version = mocks.store.readNavigationSourceVersion.getMockImplementation()!;
    const before = mocks.store.readNavigationQueryIndex.mock.calls.length;
    const stackReads = vi.spyOn(StackReader.prototype, "read");
    try {
      const shown = await read({
        ...viewer,
        project: async (index) => {
          // Saving a newer peer pin advances the durable version even when
          // the already-observed native listing is unaffected.
          mocks.store.readNavigationSourceVersion.mockReturnValue("new peer pin snapshot");
          return await viewer.project(index);
        },
      });
      expect(shown.threads).toHaveLength(2);
      expect(shown.stacks).toHaveLength(1);
      expect(source.listThreads).toHaveBeenCalledTimes(1);
      expect(mocks.store.readNavigationQueryIndex.mock.calls.length - before).toBe(1);
      expect(stackReads).toHaveBeenCalledTimes(1);
    } finally {
      mocks.store.readNavigationSourceVersion.mockImplementation(version);
      stackReads.mockRestore();
    }
  });
});

it("observes a retired Git stack before starting a new viewer lease", async () => {
  await withNavigationStackCheckout(async ({ read, viewer, retargetCatalog }) => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const layers = (index: NavigationQueryIndex) => projectSelectedStackLayers(index, { backend: "codex", threadId: "stacked" }).count;
    try {
      expect(layers(await read())).toBe(1);
      clock.mockReturnValue(started + 600);
      await retargetCatalog();
      const shown = await read(viewer);
      clock.mockReturnValue(started + 1_100);
      expect(layers(await read())).toBe(0);
      expect(layers(shown)).toBe(0);
      expect(layers(await read(viewer))).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});

it("rechecks Git at the native stack deadline even when a peer event refreshed the viewer", async () => {
  await withNavigationStackCheckout(async ({ source, read, viewer, retargetCatalog }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const layers = (index: NavigationQueryIndex) => projectSelectedStackLayers(index, { backend: "codex", threadId: "stacked" }).count;
    try {
      expect(layers(await read(viewer))).toBe(1);
      await retargetCatalog();
      vi.advanceTimersByTime(900);
      source.emit("federation/peerStatus/changed");
      expect(layers(await read(viewer))).toBe(1);
      vi.advanceTimersByTime(100);
      // The on-disk catalog retired this thread's layer. Only the original
      // native observation's one-second window may hide that change.
      expect(layers(await read(viewer))).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("keeps the owner listing when a stacked viewer with peer pins nears the byte budget", async () => {
  await withNavigationStackCheckout(async ({ source, read, viewer }) => {
    const list = source.listThreads.getMockImplementation()!;
    // The stack-free inventory and one stacked copy fit the pool. A second
    // charge for the viewer's identical stacked rows would evict the owner.
    const history = Array.from({ length: 128 }, (_, i): NavigationThreadSummary => ({
      id: `history-${i}`, source: "codex", title: "x".repeat(24_000), titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false },
    }));
    source.listThreads.mockImplementation(async () => [...await list(), ...history]);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const first = await read(viewer);
      expect(first.threads.find((thread) => thread.id === "stacked")?.stackMemberships).toHaveLength(1);
      expect(first.threads.at(-1)?.id).toBe("remote");
      expect(source.listThreads).toHaveBeenCalledTimes(1);
      source.emit("navigation/remoteThreadPins/changed");
      await read(viewer);
      expect(source.listThreads).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("isolates local owner listing and stack projection from remote pin and peer-status churn", async () => {
  await withNavigationStackSource(path.resolve(os.tmpdir(), "fixture-stack"), async ({ source, read, viewer }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Observe the navigation invalidation boundary. The checkout tests above
    // exercise live Git stack discovery and its revalidation deadline.
    const stack: StackSummary = {
      key: "fixture-stack", name: "Fixture", repository: "github.com:fixture/stack", trunk: "main", inferred: false,
      layers: [{
        branch: "topic", parent: "main", role: "layer", health: "in_sync",
        thread: { key: "codex:stacked", title: "Stacked" },
      }],
    };
    const stackReads = vi.spyOn(StackReader.prototype, "read").mockResolvedValue({ stacks: [stack], catalogs: [] });
    const materialize = mocks.store.readNavigationQueryIndex;
    let pinTitle = "Viewer pin v0";
    let peerOnline = true;
    const dynamicViewer = {
      source: viewer.source,
      project: async (index: NavigationQueryIndex) => {
        const pin: NavigationThreadSummary = {
          id: "remote",
          source: "codex",
          title: pinTitle,
          titleSource: "explicit",
          linkedDirectories: [],
          inbox: { inInbox: false },
          federation: {
            instanceLabel: "Peer",
            peerStatus: peerOnline ? "connected" : "disconnected",
            ref: buildFederatedThreadRef({ backend: "codex", threadId: "remote", instanceId: "peer" }),
          },
        };
        return appendViewerNavigationPins(index, [pin]);
      },
    };
    try {
      await fc.assert(fc.asyncProperty(
        fc.array(
          fc.constantFrom("remote-pin", "peer-disconnect", "peer-reconnect", "local-name"),
          { minLength: 4, maxLength: 8, size: "max" },
        ),
        async (events) => {
          // Expire both the owner snapshot and pool entries between cases.
          // Keep the clock fixed within each case to isolate event invalidation.
          vi.advanceTimersByTime(2_000);
          source.emit("thread/name/updated");
          pinTitle = "Viewer pin warm";
          peerOnline = true;
          const warm = await read(dynamicViewer);
          expect(warm.stacks).toHaveLength(1);
          expect(warm.threads.find((t) => t.id === "remote")?.title).toBe(pinTitle);

          source.listThreads.mockClear();
          materialize.mockClear();
          stackReads.mockClear();

          let expectedLocalRebuilds = 0;
          let step = 0;
          for (const kind of events) {
            step += 1;
            if (kind === "remote-pin") {
              pinTitle = `Viewer pin v${step}`;
              source.emit("navigation/remoteThreadPins/changed");
            } else if (kind === "peer-disconnect") {
              peerOnline = false;
              source.emit("federation/peerStatus/changed");
            } else if (kind === "peer-reconnect") {
              peerOnline = true;
              source.emit("federation/peerStatus/changed");
            } else {
              expectedLocalRebuilds += 1;
              source.emit("thread/name/updated");
            }
            const next = await read(dynamicViewer);
            expect(next.stacks).toHaveLength(1);
            const remote = next.threads.find((t) => t.id === "remote");
            expect(remote?.title).toBe(pinTitle);
            expect(remote?.federation?.peerStatus).toBe(peerOnline ? "connected" : "disconnected");
          }

          expect(source.listThreads).toHaveBeenCalledTimes(expectedLocalRebuilds);
          expect(materialize).toHaveBeenCalledTimes(expectedLocalRebuilds);
          expect(stackReads).toHaveBeenCalledTimes(expectedLocalRebuilds);
        },
      ), { numRuns: 5 });
    } finally {
      stackReads.mockRestore();
      vi.useRealTimers();
    }
  });
});

it("never requests stack projection for composer mention queries", () => {
  const queries: NavigationQueryRequest["query"][] = [
    { kind: "lens", lens: "inbox" },
    { kind: "lens", lens: "attention" },
    { kind: "directory", directoryKey: "directory:/repo" },
    { kind: "children", parent: { backend: "codex", threadId: "t1" } },
    { kind: "exact", identities: [{ backend: "codex", threadId: "t1" }] },
    { kind: "search", text: "microapps" },
    { kind: "star-map", filters: {} },
    { kind: "directory-index" },
    { kind: "group-members", roots: [{ backend: "codex", threadId: "t1" }] },
  ];
  for (const query of queries) {
    expect((navigationQueryShowsStacks as (q: NavigationQueryRequest["query"], c?: NavigationQueryRequest["consumer"]) => boolean)(query, "mentions")).toBe(false);
  }
});

it.each([true, false])("bounds cold and repeated navigation stack discovery with worktree config %s", async (extension) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-stack-fleet-")));
  const restoreGit = isolateProcessGitEnvironment();
  const source = createSource();
  const size = Number(process.env.STACK_FLEET_SIZE ?? 10);
  const primary = path.join(root, "primary");
  const common = path.join(primary, ".git");
  const home = path.join(root, "home");
  const pwragentRoot = path.join(root, "pwragent");
  const profile = "navigation-fleet";
  const stateDirectory = path.join(pwragentRoot, "profiles", profile, "state");
  let db: StateDb | undefined;
  const clock = vi.spyOn(Date, "now");
  const starts = vi.spyOn(gitSubprocessDiagnostics, "startGit");
  try {
    if (process.env.STACK_FLEET_RESOURCES) configureBundledGit(process.env.STACK_FLEET_RESOURCES);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("XDG_CONFIG_HOME", home);
    vi.stubEnv("PWRAGENT_HOME", pwragentRoot);
    vi.stubEnv("PWRAGENT_PROFILE", profile);
    await Promise.all([mkdir(home), mkdir(stateDirectory, { recursive: true })]);
    const git = async (cwd: string, ...args: string[]) => (await runGitCommand(cwd, args)).stdout.trim();
    await git(root, "init", "-b", "main", primary);
    await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--allow-empty", "-m", "Fixture");
    if (extension) await git(primary, "config", "extensions.worktreeConfig", "true");
    await git(primary, "remote", "add", "origin", "https://github.com/fixture/fleet.git");
    const head = await git(primary, "rev-parse", "HEAD");
    await git(primary, "update-ref", "refs/remotes/origin/main", head);
    await git(primary, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const worktrees: { cwd: string; alias: string; branch: string }[] = [];
    for (let index = 0; index < size; index++) {
      const branch = `topic-${index}`;
      const cwd = path.join(root, branch);
      await git(primary, "worktree", "add", "-b", branch, cwd);
      const alias = path.join(root, `alias-${index}`);
      await symlink(cwd, alias, "junction");
      worktrees.push({ cwd, alias, branch });
    }
    await writeFile(path.join(common, "gh-stack"), JSON.stringify({
      schemaVersion: 1, repository: "github.com:fixture/fleet",
      stacks: [{ trunk: { branch: "main", head }, branches: [{ branch: "topic-0", head, base: head, pullRequest: { number: 1 } }] }],
    }));
    const threads = worktrees.map(({ cwd, branch }, index): NavigationThreadSummary => ({
      id: `thread-${index}`, source: "codex", title: branch, titleSource: "explicit", gitBranch: branch,
      linkedDirectories: [{ id: cwd, path: primary, worktreePath: cwd, label: branch, kind: "worktree" }],
      inbox: { inInbox: false },
    }));
    const prs = worktrees.map(({ alias, branch }, index): PrSummary[] => [{
      number: index + 1, provider: "github.com", org: "fixture", repo: "fleet", lifecycleState: "open", state: "passing",
      url: `https://github.com/fixture/fleet/pull/${index + 1}`, headRefName: branch, baseRefName: "main",
      headSha: head, baseSha: head, linkedDirectoryPaths: [alias],
    }]);
    db = StateDb.open(path.join(stateDirectory, "state.db"), { profileName: profile });
    const profileStore = new SqliteOverlayStore(db);
    await Promise.all(threads.map((thread, index) => profileStore.setThreadPullRequests({
      backend: thread.source, threadId: thread.id, prs: prs[index]!, fetchedAt: Date.now(),
    })));
    mocks.profileStore = profileStore;
    let afterValidation: ((demand?: PrAttachmentDemand) => Promise<void>) | undefined;
    source.registry.canonicalizeNavigationPullRequests = async (prs, demand, verify = true) => {
      if (!verify) return prs;
      const filtered = await filterStoredDiscoveredPullRequests(prs, { demand });
      if (prs.some(({ number }) => number === 1)) await afterValidation?.(demand);
      return filtered;
    };
    source.listThreads.mockResolvedValue(threads);
    source.finish();

    const now = Date.now();
    const observations = [];
    const read = (signal?: AbortSignal) => loadLocalNavigationQueryIndex({
      registry: source.registry, callerReason: "renderer-navigation-query", includeStacks: true, signal,
    });
    for (const [offset, event] of [
      [0, undefined],
      [2_000, "navigation/directoryGitStatus/updated"],
      [62_000, "pullRequest/status/updated"],
      [124_000, "thread/backgroundTasks/updated"],
    ] as const) {
      clock.mockReturnValue(now + offset);
      if (event) source.emit(event);
      starts.mockClear();
      const started = performance.now();
      const result = await read();
      const calls = starts.mock.calls;
      observations.push({
        offset, ms: Math.round(performance.now() - started),
        checkout: calls.filter(([, , purpose]) => purpose === "stack-checkout").length,
        checkoutPaths: calls.filter(([cwd, [verb], purpose]) => purpose === "stack-checkout" && verb === "rev-parse" && worktrees.some((tree) => tree.cwd === cwd)).length,
        checkoutAliases: calls.filter(([cwd, [verb], purpose]) => purpose === "stack-checkout" && verb === "rev-parse" && worktrees.some((tree) => tree.alias === cwd)).length,
        pr: calls.filter(([, , purpose]) => purpose === "pr-remotes" || purpose === "pr-discovery").length,
      });
      expect(result.stacks?.[0]?.layers[0]?.thread?.key).toBe("codex:thread-0");
      expect(result.stacks?.[0]?.layers[0]?.pullRequest?.state).toBe("passing");
    }
    if (process.env.STACK_FLEET_SIZE) console.info(JSON.stringify({ size, extension, observations }));
    // A verified roster plus matching alias identity bounds checkout Git by
    // the number of clones, even when protected config is sampled anew.
    expect(observations.map(({ checkoutPaths }) => checkoutPaths)).toEqual([1, 1, 1, 1]);
    expect(observations.every(({ checkout, checkoutAliases }) => checkout <= 4 && checkoutAliases === 0)).toBe(true);
    if (process.platform !== "win32") {
      expect(observations.map(({ pr }) => pr)).toEqual([2, 2, 2, 2]);
    }

    if (extension && process.platform !== "win32") {
      const selected = worktrees[0]!;
      const unrelated = path.join(root, "unrelated");
      await git(root, "init", "-b", "main", unrelated);
      await git(unrelated, "remote", "add", "origin", "https://github.com/fixture/unrelated.git");
      const retarget = async (destination: string) => {
        await rm(selected.alias);
        await symlink(destination, selected.alias, "junction");
      };
      await retarget(unrelated);
      afterValidation = async () => {
        afterValidation = undefined;
        await retarget(selected.cwd);
      };
      source.emit("thread/name/updated");
      expect((await read()).stacks?.[0]?.layers[0]?.pullRequest?.state).toBe("passing");

      // Edit protected config after the shared remote observation has read
      // Git. Only the fresh config may supply this layer's attached status.
      afterValidation = async () => {
        afterValidation = undefined;
        await writeFile(path.join(home, ".gitconfig"),
          '[url "https://github.com/fixture/replaced.git"]\n\tinsteadOf = https://github.com/fixture/fleet.git\n');
      };
      source.emit("thread/name/updated");
      const changed = await read();
      expect(await git(worktrees[0]!.alias, "remote", "get-url", "origin")).toBe("https://github.com/fixture/replaced.git");
      expect(changed.stacks?.[0]?.layers[0]?.pullRequest).toMatchObject({ number: 1 });
      expect(changed.stacks?.[0]?.layers[0]?.pullRequest?.state).toBeUndefined();

      const entered = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const controller = new AbortController();
      afterValidation = async (demand) => {
        afterValidation = undefined;
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (demand?.signal?.aborted) resolve();
          else demand?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        finished.resolve();
      };
      source.emit("thread/name/updated");
      const cancelled = read(controller.signal);
      await entered.promise;
      const stopped = new Error("stack projection cancelled");
      controller.abort(stopped);
      await expect(cancelled).rejects.toBe(stopped);
      await finished.promise;
      await rm(path.join(home, ".gitconfig"));
      source.emit("thread/name/updated");
      expect((await read()).stacks?.[0]?.layers[0]?.pullRequest?.state).toBe("passing");

      await git(primary, "update-ref", "refs/remotes/origin/topic-0", head);
      afterValidation = async () => {
        afterValidation = undefined;
        await git(primary, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic-0");
      };
      source.emit("thread/name/updated");
      const newDefault = await read();
      expect(await git(selected.cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).toBe("origin/topic-0");
      expect(newDefault.stacks?.[0]?.layers[0]?.pullRequest?.state).toBeUndefined();
    }

    if (!extension && process.platform !== "win32") {
      await git(primary, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      source.emit("thread/name/updated");
      expect((await read()).stacks?.[0]?.layers[0]?.pullRequest?.state).toBe("passing");
      source.emit("thread/name/updated");
      starts.mockClear();
      expect((await read()).stacks?.[0]?.layers[0]?.pullRequest?.state).toBe("passing");
      expect(starts.mock.calls.filter(([, , purpose]) => purpose === "pr-remotes" || purpose === "pr-discovery"))
        .toHaveLength(0);

      await git(primary, "update-ref", "refs/remotes/origin/topic-0", head);
      await git(primary, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic-0");
      source.emit("thread/name/updated");
      expect((await read()).stacks?.[0]?.layers[0]?.pullRequest?.state).toBeUndefined();
    }

    // Recovery has a separate journal gate. An explicit observation always
    // asks Git about the requested checkout after the background reads.
    starts.mockClear();
    await expect(new StackOperationsService().resumeInterrupted(worktrees.map(({ cwd }) => cwd), source.registry)).resolves.toEqual([]);
    expect(starts.mock.calls.filter(([, , purpose]) => purpose === "stack-checkout")).toHaveLength(0);
    const selected = worktrees[0]!;
    await expect(readStackClones([selected.alias])).resolves.toMatchObject([{ root: selected.cwd, commonDir: common }]);
    expect(starts.mock.calls.filter(([, , purpose]) => purpose === "stack-checkout").map(([cwd, [verb]]) => [cwd, verb]))
      .toEqual([[selected.alias, "rev-parse"]]);
  } finally {
    starts.mockRestore();
    clock.mockRestore();
    source.emit("thread/name/updated");
    mocks.profileStore = undefined;
    db?.close();
    configureBundledGit();
    vi.unstubAllEnvs();
    restoreGit();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("reuses the warm sidebar index across historical fill corrections and rereads when the winner moves", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const db = StateDb.open(":memory:");
  const source = createSource();
  try {
    const overlay = new SqliteOverlayStore(db);
    mocks.profileStore = overlay;
    const threads = Array.from({ length: 32 }, (_, i): NavigationThreadSummary => ({
      id: `thread-${i}`, source: "codex", title: "Fixture", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: true },
    }));
    source.listThreads.mockResolvedValue(threads);
    source.finish();
    const insert = db.raw.prepare(`INSERT INTO thread_usage_turns
      (usage_turn_id, provider, backend, thread_id, observed_at, updated_at, final_context_tokens, model_context_window)
      VALUES (?, 'openai', 'codex', 'thread-0', ?, 1, ?, 1000)`);
    insert.run("current", 100, 60);
    const store = new NavigationQueryStore();
    const read = async () => (await store.readPage({ scopeKey: "fixture",
      request: { protocol: 2, consumer: "main-sidebar", query: { kind: "exact", identities: [{ backend: "codex", threadId: "thread-0" }] } },
      loadIndex: () => loadSidebarNavigationQueryIndex({ registry: source.registry, callerReason: "renderer-navigation-query" }),
    })).entries[0]?.row.contextWindow?.totalTokens;
    const projection = vi.spyOn(overlay, "readNavigationQueryIndex");
    const rowProjection = vi.spyOn(overlay, "readNavigationQueryThreads");
    expect(await read()).toBe(60);
    // A later rowid wins a time tie, but an identical fill still reuses the page.
    insert.run("repeat", 100, 60);
    expect(await read()).toBe(60);
    db.raw.exec("DELETE FROM thread_usage_turns WHERE usage_turn_id = 'repeat'");
    expect(await read()).toBe(60);
    insert.run("backfill", 80, 10);
    expect(await read()).toBe(60);
    db.raw.exec("UPDATE thread_usage_turns SET final_context_tokens = 35 WHERE usage_turn_id = 'backfill'");
    expect(await read()).toBe(60);
    insert.run("obsolete", 75, 30);
    db.raw.exec("DELETE FROM thread_usage_turns WHERE usage_turn_id = 'obsolete'");
    expect(await read()).toBe(60);
    expect(projection).toHaveBeenCalledTimes(1);
    expect(rowProjection).toHaveBeenCalledTimes(1);
    // Backdating the leader reveals the previously corrected reading.
    db.raw.exec("UPDATE thread_usage_turns SET observed_at = 50 WHERE usage_turn_id = 'current'");
    expect(await read()).toBe(35);
    expect(projection).toHaveBeenCalledTimes(1);
    expect(rowProjection).toHaveBeenCalledTimes(2);
    expect(rowProjection.mock.lastCall?.[0].threads.map((row) => row.id)).toEqual(["thread-0"]);
  } finally {
    source.emit("thread/name/updated");
    mocks.profileStore = undefined;
    db.close();
    vi.useRealTimers();
  }
});
