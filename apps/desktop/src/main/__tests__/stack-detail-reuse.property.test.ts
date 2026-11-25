import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type { NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { NavigationDirectoryScope } from "@pwragent/owner-core/navigation-directory-scope";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { isolateProcessGitEnvironment, runIsolatedGitSync } from "./helpers/isolated-git";

const mocks = vi.hoisted(() => ({
  store: {
    readNavigationPullRequests: vi.fn((): PrSummary[][] => []),
    readNavigationSourceVersion: vi.fn(() => "unchanged"),
    getThreadPrAutoDispatchPending: vi.fn(async () => undefined),
    readNavigationQueryIndex: vi.fn((params: { threads: NavigationThreadSummary[] }): NavigationQueryIndex =>
      ({ threads: params.threads, directories: [] })),
    readDirectoryGitStatusCache: vi.fn(async () => ({})),
    listAllActivePrStatusWatches: vi.fn(async () => []),
  },
  messaging: { findActiveBindings: vi.fn(async () => []), findActiveBindingsForThread: async () => [] },
}));
vi.mock("../storage/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.store }));
vi.mock("../messaging/desktop-messaging-store", () => ({ getDesktopMessagingStore: () => mocks.messaging }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: vi.fn() }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import {
  loadLocalNavigationQueryIndex, projectSelectedStackLayers, readNavigationStackLayers, STACK_DETAIL_REUSE_MS,
} from "../app-server/navigation-query-source";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";

const git = (cwd: string, ...args: string[]) => runIsolatedGitSync(cwd, args).trim();
const commit = (cwd: string, message: string) =>
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", message);

const INVALIDATING = ["turn/completed", "pullRequest/status/updated", "thread/name/updated", "thread/pullRequests/updated"] as const;
const QUIET = ["item/agentMessage/delta", "thread/tokenUsage/updated"] as const;

type Step =
  | { kind: "sidebar"; eventDuringRead: boolean }
  | { kind: "detail"; layer: number }
  | { kind: "event"; method: string }
  | { kind: "advance"; ms: number }
  | { kind: "git-change"; layer: number };

const steps: fc.Arbitrary<Step[]> = fc.array(fc.oneof(
  fc.record({ kind: fc.constant("sidebar" as const), eventDuringRead: fc.boolean() }),
  fc.record({ kind: fc.constant("detail" as const), layer: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant("detail" as const), layer: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant("event" as const), method: fc.constantFrom(...INVALIDATING, ...QUIET) }),
  fc.record({ kind: fc.constant("advance" as const), ms: fc.constantFrom(2_000, 9_000, STACK_DETAIL_REUSE_MS + 1) }),
  fc.record({ kind: fc.constant("git-change" as const), layer: fc.integer({ min: 1, max: 3 }) }),
), { minLength: 2, maxLength: 9 });

it("answers a stack detail read from the newest projection exactly while no stack input has changed", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-detail-reuse-")));
  const restoreGit = isolateProcessGitEnvironment();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const original = gitSubprocessDiagnostics.startGit;
  let spawns = 0;
  const spy = vi.spyOn(gitSubprocessDiagnostics, "startGit").mockImplementation((...args) => {
    spawns += 1;
    return original.call(gitSubprocessDiagnostics, ...args);
  });
  try {
    const root = path.join(base, "repo");
    git(base, "init", "-q", "-b", "main", root);
    commit(root, "trunk");
    const heads = [git(root, "rev-parse", "HEAD")];
    const worktrees: string[] = [];
    for (let index = 1; index <= 3; index++) {
      git(root, "checkout", "-q", "-b", `s${index}`);
      commit(root, `layer ${index}`);
      heads.push(git(root, "rev-parse", "HEAD"));
    }
    git(root, "checkout", "-q", "main");
    for (let index = 1; index <= 3; index++) {
      git(root, "worktree", "add", "-q", path.join(base, `wt${index}`), `s${index}`);
      worktrees.push(await realpath(path.join(base, `wt${index}`)));
    }
    await writeFile(path.join(root, ".git", "gh-stack"), JSON.stringify({
      schemaVersion: 1, repository: "github.com:fixture/reuse",
      stacks: [{ trunk: { branch: "main", head: heads[0] }, branches: [1, 2, 3].map((index) => ({
        branch: `s${index}`, head: heads[index], base: heads[index - 1], pullRequest: { number: 10 + index },
      })) }],
    }));
    const threads = worktrees.map((worktree, index): NavigationThreadSummary => ({
      id: `layer-${index + 1}`, source: "codex", title: `Layer ${index + 1}`, titleSource: "explicit",
      gitBranch: `s${index + 1}`, inbox: { inInbox: false },
      linkedDirectories: [{ id: worktree, path: worktree, kind: "local", label: "reuse" }],
    }));
    const prs = worktrees.map((worktree, index): PrSummary => ({
      provider: "github.com", org: "fixture", repo: "reuse", number: 11 + index, state: "passing", lifecycleState: "open",
      url: `https://github.com/fixture/reuse/pull/${11 + index}`, headRefName: `s${index + 1}`,
      baseRefName: index ? `s${index}` : "main", headSha: heads[index + 1], linkedDirectoryPaths: [worktree],
    }));
    mocks.store.readNavigationPullRequests.mockImplementation(() => prs.map((pr) => [pr]));

    await fc.assert(fc.asyncProperty(steps, async (plan) => {
      // Each run is a fresh owner: its own registry, epoch and projection.
      const listeners = new Set<(event: AgentEvent) => void>();
      const emit = (method: string) => {
        for (const listener of listeners) listener({ backend: "codex", notification: { method, params: { threadId: "layer-1" } } } as AgentEvent);
      };
      let emitDuringListing: string | undefined;
      const registry = {
        listThreads: async () => {
          if (emitDuringListing) emit(emitDuringListing);
          emitDuringListing = undefined;
          return threads;
        },
        onEvent: (listener: (event: AgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        withNavigationPrimaryGitRepositories: (rows: unknown) => rows,
        hydrateThreadGitWorkingStates: async (rows: unknown) => rows,
        withNavigationSubAgentActivity: (rows: unknown) => rows,
        getNavigationInputRequestThreadKeys: () => new Set<string>(),
        rememberNavigationVisibilityIndex: () => {},
        navigationDirectoryScope: new NavigationDirectoryScope(),
        getStartupProviderRefreshStatus: () => ({ state: "ready" }),
        isIncompleteThreadList: () => false,
        canonicalizeNavigationPullRequests: async (rows: PrSummary[]) => rows,
        stackThreadHeld: () => false,
        stackRepairActive: async () => false,
      } as unknown as DesktopBackendRegistry;
      vi.mocked(getDesktopBackendRegistry).mockReturnValue(registry);
      const read = () => loadLocalNavigationQueryIndex({ registry, callerReason: "renderer-navigation-query", includeStacks: true });

      // Model: the stack input epoch, and the newest projection's epoch,
      // completion time and index.
      let epoch = 0;
      let projection: { epoch: number; at: number; index: NavigationQueryIndex } | undefined;
      for (const step of plan) {
        if (step.kind === "sidebar") {
          // Past the pool's one-second retention, so every sidebar read projects.
          now += 1_500;
          if (step.eventDuringRead) emitDuringListing = "turn/completed";
          const startedAt = epoch;
          const index = await read();
          if (step.eventDuringRead) epoch += 1;
          projection = { epoch: startedAt, at: now, index };
        } else if (step.kind === "detail") {
          const ref = { backend: "codex" as const, threadId: `layer-${step.layer}` };
          const reusable = projection && projection.epoch === epoch && now - projection.at <= STACK_DETAIL_REUSE_MS;
          const before = spawns;
          const detail = await readNavigationStackLayers(ref);
          if (reusable) {
            expect(spawns - before).toBe(0);
          } else {
            // Git is observed afresh; that read is now the newest projection.
            expect(spawns - before).toBeGreaterThan(0);
            projection = { epoch, at: now, index: await read() };
          }
          const expected = projectSelectedStackLayers(projection!.index, ref);
          expect(detail.count).toBe(3);
          expect(detail.revision).toBe(expected.revision);
          expect(detail.page(0, 3)).toEqual(expected.page(0, 3));
        } else if (step.kind === "event") {
          emit(step.method);
          if ((INVALIDATING as readonly string[]).includes(step.method)) epoch += 1;
        } else if (step.kind === "advance") {
          now += step.ms;
        } else {
          // Git moves with no event: only a projection observes it.
          commit(worktrees[step.layer - 1]!, "moved");
        }
      }
      emit("navigation/invalidated");
    }), {
      numRuns: 30,
      examples: [
        // A hover after the pool's retention but within the reuse window.
        [[{ kind: "sidebar", eventDuringRead: false }, { kind: "advance", ms: 2_000 }, { kind: "detail", layer: 2 }]],
        // Streaming and token events change no stack input.
        [[{ kind: "sidebar", eventDuringRead: false }, { kind: "event", method: "item/agentMessage/delta" },
          { kind: "advance", ms: 9_000 }, { kind: "detail", layer: 1 }]],
        // A stack input changed: the hover observes Git, then later hovers reuse that read.
        [[{ kind: "sidebar", eventDuringRead: false }, { kind: "event", method: "pullRequest/status/updated" },
          { kind: "git-change", layer: 3 }, { kind: "detail", layer: 3 }, { kind: "advance", ms: 2_000 }, { kind: "detail", layer: 1 }]],
        // A change that lands while the projection reads leaves it stale.
        [[{ kind: "sidebar", eventDuringRead: true }, { kind: "detail", layer: 2 }]],
        // Past the window, even with nothing evented.
        [[{ kind: "sidebar", eventDuringRead: false }, { kind: "advance", ms: STACK_DETAIL_REUSE_MS + 1 }, { kind: "detail", layer: 2 }]],
      ],
    });
  } finally {
    spy.mockRestore();
    clock.mockRestore();
    vi.mocked(getDesktopBackendRegistry).mockReset();
    restoreGit();
    await rm(base, { recursive: true, force: true });
  }
}, 180_000);
