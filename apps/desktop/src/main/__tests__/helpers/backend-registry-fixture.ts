import { createDesktopBackendRegistry, registryModules } from "../../app-server/backend-registry-wiring";
import { getOwnerHostServices, installOwnerHostServices } from "../../owner-host";
import { isolatedGitKeys, isolateProcessGitEnvironment } from "../helpers/isolated-git";
import { DEFAULT_THREAD_ARCHIVE_POLICY } from "@pwragent/shared/thread-archive-policy";
import { ThreadCorrespondenceStore } from "../../app-server/thread-correspondence-store";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  vi,
} from "vitest";
import { applyNavigationLaunchpadDefaultsPatch, buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { claimAgentReviewBudget, rearmAgentReviewBudget, type AgentReviewAdmission, type AgentReviewBudget, type OperatorReviewInput } from "@pwragent/owner-core/agent-review-admission";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import { buildNavigationSnapshot } from "@pwragent/shared/navigation-state";
import { buildPrependPinRank } from "@pwragent/shared/thread-pins";
import { resolveHelperModel, type HelperModelId } from "@pwragent/shared/helper-models";
import type {
  AcpBackendId,
  AppServerBackendKind,
  AppServerNotification,
  AppServerAvailableCommandSummary,
  AppServerPendingRequestNotification,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadActivityEntry,
  AppServerThreadMessageOrigin,
  AppServerThreadSummary,
  AppServerReviewTarget,
  AppServerTurnInputItem,
  CodexThreadEnvironmentRuntime,
  LinkedDirectorySummary,
  ThreadToolAccounting,
  WorktreeSnapshotSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  BackendAccountSummary,
  BackendAcpRuntimeCapabilities,
  BackendAcpSessionRuntimeState,
  BackendModelOption,
  BackendRateLimitSummary,
} from "@pwragent/shared/contracts/backend";
import type {
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
  ThreadOverlayState,
  ThreadSubAgentSummary,
} from "@pwragent/shared/contracts/navigation";
import type {
  PwrAgentThreadOrchestrationRequest,
  PwrAgentThreadOrchestrationResponse,
} from "@pwragent/shared/contracts/thread-orchestration-tools";
import type { ThreadPullRequestWatchSummary } from "@pwragent/shared/contracts/thread-tools";
import type { ThreadSpendAlert, ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type {
  ThreadForkParams as CodexThreadForkParams,
  ThreadSource as CodexThreadSource,
  ThreadStartParams as CodexThreadStartParams,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { DesktopBackendRegistry } from "../../app-server/backend-registry";
import type { CodexPwrdrvrTokenMiserActivation, CodexServerCapabilities } from "../../codex-app-server/desktop-client";
import { CodexAppServerClient } from "../../codex-app-server/desktop-client";
import { isBindingForThread } from "../../messaging/core/messaging-binding-thread-match";
import { issueProviderDiscoveryPermit } from "../../settings/provider-discovery-permit";
import type { AcpAvailableCommandsRecord } from "@pwragent/owner-core/acp-storage";
import { type CodexEnvironmentCommandRunner } from "../../app-server/codex-environment-runtime";
import {
  mockSubAgentReads,
  mockUsageActivityReads,
  type MockOverlayState,
  type MockOverlayStore,
} from "../helpers/mock-sub-agent-store";
import { WorktreeArchiveService } from "../../app-server/worktree-archive-service";
import type { AcpInstalledAgentRecord } from "../../acp/acp-registry-types";
import { AcpRolloutStore } from "../../acp/acp-rollout-store";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import { resolveAgentToolCatalogs } from "../../agent-tools/agent-tool-catalog-registry";
import type { AgentToolMcpRegistration, AgentToolMcpServerLike } from "../../agent-tools/agent-tool-mcp-server";


export const jeepStickerPageFixture = fileURLToPath(
  new URL("../fixtures/pdf/jeep-sticker-page-size.pdf", import.meta.url),
);

const mainLoggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

/** Model folder presence alongside a fake snapshot/removal service. Unrelated
 * paths still use the real filesystem, including missing-folder regressions. */
export async function mockArchiveWorktreePresence(paths: string[], exists: (target: string) => boolean = () => true): Promise<void> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const previous = vi.mocked(stat).getMockImplementation() ?? actual.stat;
  vi.mocked(stat).mockImplementation(async (target, options) => {
    if (typeof target === "string" && paths.some((candidate) => path.resolve(candidate) === path.resolve(target))) {
      if (!exists(target)) throw Object.assign(new Error("Fixture worktree removed"), { code: "ENOENT" });
      return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
    }
    return await actual.stat(target, options);
  });
  onTestFinished(() => { vi.mocked(stat).mockImplementation(previous); });
}

vi.mock("../../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("../fixtures/archive-cleanup-transport")).ArchiveCleanupTransport,
}));

vi.mock("../../log", () => ({
  getMainLogger: vi.fn(() => mainLoggerMock),
}));

const localAcpDiscoveryMock = vi.hoisted(() => ({
  discoverLocalAcpAgentRecords: vi.fn(
    async () => [] as AcpInstalledAgentRecord[],
  ),
}));

vi.mock("../../acp/acp-instance-discovery", () => localAcpDiscoveryMock);

const desktopNotificationServiceMock = vi.hoisted(() => {
  const notifyApproval = vi.fn();
  const notifyAttention = vi.fn();
  const notifyTerminal = vi.fn();
  const clearAttentionKey = vi.fn();
  const service = { notifyApproval, notifyAttention, notifyTerminal, clearAttentionKey };
  return {
    notifyApproval,
    notifyAttention,
    notifyTerminal,
    clearAttentionKey,
    getDesktopNotificationService: vi.fn(() => service),
  };
});

vi.mock("../../shell/notifications/desktop-notification-service", () => ({
  getDesktopNotificationService:
    desktopNotificationServiceMock.getDesktopNotificationService,
}));

const requestShowThreadMock = vi.hoisted(() => vi.fn());

// `[federation] member_role` as a desktop's config.toml would set it. Unset,
// the config store is the real singleton, which tests never create.
const configuredMemberRole = vi.hoisted(() => ({ role: undefined as "full" | "contained" | undefined }));

vi.mock("../../settings/config-store/desktop-config-store-singleton", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../settings/config-store/desktop-config-store-singleton")>();
  return {
    ...actual,
    getExistingDesktopConfigStore: () => configuredMemberRole.role
      ? { read: (section: string) => section === "federation" ? { memberRole: configuredMemberRole.role } : {} } as never
      : actual.getExistingDesktopConfigStore(),
  };
});

vi.mock("../../shell/window-show-thread", () => ({
  requestShowThread: requestShowThreadMock,
}));

type DynamicToolTestSpec = {
  name: string;
  description?: string;
  inputSchema?: {
    required?: string[];
  };
};

export function pwragentDynamicTools(dynamicTools: unknown): DynamicToolTestSpec[] {
  if (!Array.isArray(dynamicTools)) {
    return [];
  }
  const namespace = dynamicTools.find(
    (tool): tool is { type: "namespace"; name: string; tools: unknown[] } =>
      Boolean(tool)
      && typeof tool === "object"
      && (tool as { type?: unknown }).type === "namespace"
      && (tool as { name?: unknown }).name === "pwragent"
      && Array.isArray((tool as { tools?: unknown }).tools),
  );
  return namespace?.tools as DynamicToolTestSpec[] ?? [];
}

export function isCompletedItemType(event: AgentEvent, itemType: string): boolean {
  if (event.notification.method !== "item/completed") {
    return false;
  }
  const item = event.notification.params.item;
  return Boolean(
    item
    && typeof item === "object"
    && "type" in item
    && item.type === itemType,
  );
}

export function expectPwragentDynamicTools(dynamicTools: unknown, names: string[]): void {
  expect(pwragentDynamicTools(dynamicTools)).toEqual(
    expect.arrayContaining(
      names.map((name) =>
        expect.objectContaining({
          type: "function",
          name,
        }),
      ),
    ),
  );
}

export function createPdfMcpServerMock() {
  const bindThread = vi.fn<(threadId: string) => void>();
  const registration = {
    server: {
      name: "pwragent",
      type: "http" as const,
      url: "http://127.0.0.1:42137/mcp",
      headers: [
        {
          name: "Authorization",
          value: "Bearer pwragent-pdf-test-token",
        },
      ],
    },
    bindThread,
  } satisfies AgentToolMcpRegistration;
  const registerClient = vi.fn<AgentToolMcpServerLike["registerClient"]>(
    async () => registration,
  );
  const close = vi.fn<AgentToolMcpServerLike["close"]>(async () => undefined);
  return {
    bindThread,
    close,
    registerClient,
    server: {
      close,
      registerClient,
    },
  };
}

export const execFileAsync = promisify(execFileCallback);

// The registry resolves Codex worktree/project cwds and surfaces them as
// forward-slashed directory identifiers (path.resolve + slash flip, matching
// the enricher's toDirectoryId). `expectedDir` mirrors that so expected ids
// match the received values on both POSIX and Windows: it is a no-op for an
// absolute POSIX path, and on Windows turns `/Users/x` into `C:/Users/x`.
export function expectedDir(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

export function createAgentOverlay(threadId = "agent-thread"): ThreadOverlayState {
  return {
    backend: "codex",
    threadId,
    executionMode: "default",
    extraLinkedDirectories: [],
    agent: {
      name: "Parent Agent",
      instructionLineCount: 0,
      instructionsTooLong: false,
      updatedAt: 1_000,
    },
  };
}

export async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

// Every `git` below runs against this environment instead of whatever the
// machine happens to be configured with. Three separate reasons:
//
// 1. Identity. Supplying it as GIT_AUTHOR_*/GIT_COMMITTER_* removes the two
//    `git config` spawns each repo used to pay for, and the `-c user.name=`
//    argument pairs every `commit` used to carry. A commit is authored the
//    same way whether the test set identity up or not, so no repo here can
//    fail on "please tell me who you are" for having forgotten the setup.
// 2. Ambient configuration. Global config is redirected to an empty file and
//    system config is switched off, so a runner's gitconfig cannot reach
//    these repos: no credential helper, no `init.defaultBranch`, no
//    `commit.gpgsign` waiting on a passphrase. What the assertions see is
//    what this file set. Repo-location variables are unset for the same
//    reason — see the entries below.
// 3. Prompting. A git that blocks on a terminal prompt does not fail, it
//    hangs, and a hang is charged to the whole test timeout rather than to
//    the command that caused it.
//
// PwrGit's e2e sandbox (`apps/desktop/e2e/fixtures/git-sandbox.ts` there)
// neutralizes config by pointing these at `/dev/null`. That path does not
// exist on Windows, so this uses a real empty file, which reads as "no
// configuration" on every platform. The non-interactive pair matches
// `NON_INTERACTIVE_GIT_ENV` in PwrGit's `main/git/dugite.ts`; the dugite
// binary it guards there is a production concern and is deliberately not
// adopted here, since these spawns are test setup against PATH git.
const gitConfigDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-git-config-"));
const emptyGitConfigPath = path.join(gitConfigDir, "empty.gitconfig");
writeFileSync(emptyGitConfigPath, "");

export const gitTestEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !isolatedGitKeys.test(key))),
  // A repo-location variable inherited from the outside would redirect every
  // command below at whatever repo the suite was launched from — `git rebase
  // -x`, a pre-push hook, and any npm lifecycle script running inside a git
  // operation all export these. `git -C <fixture>` does not override them, so
  // an inherited GIT_DIR would point `add` and `commit` at the outer repo's
  // index while the fixture path only chose the cwd. Node drops env keys whose
  // value is undefined, so this unsets them for the child.
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_CONFIG_GLOBAL: emptyGitConfigPath,
  GIT_CONFIG_SYSTEM: emptyGitConfigPath,
  // GIT_CONFIG_SYSTEM replaces `$(prefix)/etc/gitconfig`, but Git for Windows
  // reads a second system-level file at `%PROGRAMDATA%\Git\config` that the
  // installer writes to — including, in a default install, a credential
  // helper. That one is gated on GIT_CONFIG_NOSYSTEM rather than on the path
  // override, so the path override alone would leave the exact setting this
  // env exists to keep out, on the exact platform it matters for.
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "PwrAgent Tests",
  GIT_AUTHOR_EMAIL: "tests@pwragent.local",
  GIT_COMMITTER_NAME: "PwrAgent Tests",
  GIT_COMMITTER_EMAIL: "tests@pwragent.local",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
};

// The directory for a thread whose subject is not Git. Starting a thread in
// the suite's own checkout ran `git rev-parse --abbrev-ref HEAD` against it
// whenever the head-branch file probe could not prove the layout (a linked
// worktree, for one), and reading its working state ran ten more commands
// across the whole tree: about a second per call on a CI runner. An empty
// directory under the temp dir is provably not a repository, so the probe
// answers from the filesystem and nothing is spawned.
export const nonRepositoryCwd = mkdtempSync(path.join(os.tmpdir(), "pwragent-registry-cwd-"));

afterAll(() => {
  rmSync(gitConfigDir, { force: true, recursive: true });
  rmSync(nonRepositoryCwd, { force: true, recursive: true });
});

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitTestEnv,
    maxBuffer: 1024 * 1024 * 10,
  });
  return stdout.trim();
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

/**
 * Waits a bounded number of macrotask turns for in-memory or test-double work.
 * Never use it for work that can reach host I/O (filesystem, git, child
 * processes): no turn count bounds that on a slow runner. Await the owned
 * promise or a registry `...ForTests()` hook instead. Fails here, rather than
 * at a later assertion that would misreport the cause.
 */
export async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) {
      return;
    }
    await flushAsync();
  }
  expect(predicate(), "waitForCondition predicate never held").toBe(true);
}

/**
 * Settles with the method of the next terminal turn event. Register it before
 * the action that ends the turn. The registry runs Git before it publishes the
 * terminal event (the branch check at turn end; a review turn first resolves
 * its card's provenance). On a loaded Windows runner each Git round took over
 * half a second, so a polling budget cannot fit. The test timeout bounds this
 * wait instead.
 */
export function nextTurnEnd(registry: DesktopBackendRegistry): Promise<string> {
  return new Promise((resolve) => {
    const unsubscribe = registry.onEvent((event) => {
      const { method } = event.notification;
      if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
        unsubscribe();
        resolve(method);
      }
    });
  });
}

export async function expectEventually<T>(
  read: () => Promise<T>,
  expected: T,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  let lastValue: T | undefined;
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = await read();
      if (lastValue === expected) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (lastError && lastValue === undefined) {
    throw lastError;
  }
  expect(lastValue).toBe(expected);
}

/**
 * One finalized overlay turn-usage row. The overlay keeps these outside the
 * provider rollout, so a read has to place them against the page it returns.
 */
export function usageActivity(params: {
  createdAt: number;
  turnId?: string;
  id?: string;
}): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: params.id ?? `live-turn-usage-${params.turnId}`,
    summary: "Turn usage: 1,000 uncached in · 2,000 cached · 300 out",
    status: "completed",
    createdAt: params.createdAt,
    ...(params.turnId
      ? { turn: { id: params.turnId, status: "completed" as const } }
      : {}),
    details: [],
  };
}

export const sampleGitWorkingState = {
  dirtyFiles: 0,
  dirtyAdditions: 0,
  dirtyDeletions: 0,
  untrackedFiles: 0,
  unpushedCommits: 0,
  baseBranch: "main",
  baseAheadCommitCount: 16,
};

export function activeWorkingStateThread(params: Parameters<typeof multiProjectThread>[0]): AppServerThreadSummary {
  return { ...multiProjectThread(params), threadStatus: "active" };
}

export function multiProjectThread(params: {
  worktreePath: string;
}): AppServerThreadSummary {
  return {
    id: `thread-${params.worktreePath}`,
    title: "PwrAgent federation dogfood",
    titleSource: "explicit",
    source: "codex",
    projectKey: params.worktreePath,
    linkedDirectories: [
      {
        id: "pwragent",
        kind: "worktree",
        label: "PwrAgnt",
        path: "/repos/PwrAgnt",
        worktreePath: params.worktreePath,
      },
      {
        id: "pwrsnap",
        kind: "local",
        label: "PwrSnap",
        path: "/repos/PwrSnap",
      },
    ],
  };
}

export function createOverlayStoreMock(params?: {
  executionMode?: "default" | "auto" | "full-access";
  launchpadDefaults?: NavigationLaunchpadDefaults;
  overlays?: Record<string, MockOverlayState>;
  remotePinnedRanks?: string[];
  toolAccounting?: ThreadToolAccounting;
}) {
  const reviewBudgets = new Map<string, AgentReviewBudget>();
  const toolAccounting: ThreadToolAccounting = params?.toolAccounting ?? {
    alerts: [],
    invocations: [],
    summaries: [],
  };
  const initialOverlay = params?.executionMode
    ? {
        backend: "codex" as const,
        threadId: "thread-1",
        executionMode: params.executionMode,
        extraLinkedDirectories: [],
      }
    : undefined;
  const overlays = new Map<string, MockOverlayState>(
    Object.entries(params?.overlays ?? {})
  );
  const usageLines = new Map<string, ThreadUsageLineRecord>();
  const messageOrigins = new Map<string, AppServerThreadMessageOrigin>();
  const upsertThreadMessageOrigin = vi.fn(async ({
    backend,
    threadId,
    messageId,
    origin,
  }: {
    backend: AppServerBackendKind;
    threadId: string;
    messageId: string;
    origin: AppServerThreadMessageOrigin;
  }) => {
    messageOrigins.set(`${backend}:${threadId}:${messageId}`, origin);
  });
  let launchpadDefaults: NavigationLaunchpadDefaults = {
    backend: "codex",
    executionMode: "default",
    workMode: "local",
    ...params?.launchpadDefaults,
  };
  const launchpads = new Map<string, NavigationLaunchpadDraft>();
  if (initialOverlay) {
    overlays.set("codex:thread-1", initialOverlay);
  }

  return {
    readAgentReviewBudget: ({ backend, threadId }: Pick<AgentReviewAdmission, "backend" | "threadId">) =>
      reviewBudgets.get(buildThreadIdentityKey(backend, threadId)),
    claimAgentReview: (request: AgentReviewAdmission) => {
      const key = buildThreadIdentityKey(request.backend, request.threadId);
      const next = claimAgentReviewBudget(reviewBudgets.get(key), request);
      if (typeof next === "string") return next;
      reviewBudgets.set(key, next);
      return undefined;
    },
    rearmAgentReviews: ({ backend, threadId }: Pick<AgentReviewAdmission, "backend" | "threadId">, input: OperatorReviewInput) => {
      const key = buildThreadIdentityKey(backend, threadId);
      const next = rearmAgentReviewBudget(reviewBudgets.get(key), input);
      if (next) reviewBudgets.set(key, next);
    },
    listAllActivePrStatusWatches: async (): Promise<ThreadPullRequestWatchSummary[]> => [],
    listActiveThreadPrStatusWatches: async (_params: {
      backend: string;
      threadId: string;
    }): Promise<ThreadPullRequestWatchSummary[]> => [],
    ...mockSubAgentReads((backend, threadId) =>
      overlays.get(`${backend}:${threadId}`)),
    ...mockUsageActivityReads((backend, threadId) =>
      overlays.get(`${backend}:${threadId}`)),
    listRemoteThreadPins: async () =>
      (params?.remotePinnedRanks ?? []).map((localPinnedRank, index) => ({
        ref: buildFederatedThreadRef({
          backend: "codex",
          instanceId: "peer-laptop",
          threadId: `remote-${index + 1}`,
        }),
        addedAt: 1_000 + index,
        instanceLabel: "Laptop",
        localPinnedRank,
      })),
    getThreadMetadata: async ({ backend, threadId }: { backend: AppServerBackendKind; threadId: string }) => {
      const overlay = overlays.get(`${backend}:${threadId}`);
      return overlay ? { backend, threadId, executionMode: overlay.executionMode ?? "default", model: overlay.model } : undefined;
    },
    getThreadOverlayState: async ({
      backend,
      threadId,
    }: {
      backend: ThreadOverlayState["backend"];
      threadId: string;
    }) => overlays.get(`${backend}:${threadId}`),
    setThreadTokenMiser: async ({
      backend,
      threadId,
      enabled,
    }: {
      backend: ThreadOverlayState["backend"];
      threadId: string;
      enabled: boolean | null;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const { tokenMiserEnabled: _cleared, ...rest } = current;
      const next = enabled === null
        ? rest
        : { ...current, tokenMiserEnabled: enabled };
      overlays.set(key, next);
      return next;
    },
    setThreadSpendAlertPending: async ({
      alert,
      backend,
      threadId,
    }: {
      alert: ThreadSpendAlert;
      backend: ThreadOverlayState["backend"];
      threadId: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      if (
        current.threadSpendAlertedAt !== undefined
        || current.threadSpendAlertPending !== undefined
      ) return current;
      const next = {
        ...current,
        threadSpendAlertPending: alert,
      };
      overlays.set(key, next);
      return next;
    },
    acknowledgeThreadSpendAlert: async ({
      alertId,
      backend,
      threadId,
    }: {
      alertId: string;
      backend: ThreadOverlayState["backend"];
      threadId: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key);
      if (current?.threadSpendAlertPending?.alertId !== alertId) return false;
      const next: ThreadOverlayState = {
        ...current,
        threadSpendAlertedAt: Date.now(),
      };
      delete next.threadSpendAlertPending;
      overlays.set(key, next);
      return true;
    },
    getThreadOverlayStates: async ({
      backend,
      threadIds,
    }: {
      backend: AppServerBackendKind;
      threadIds: string[];
    }) =>
      Object.fromEntries(
        threadIds.map((threadId) => [threadId, overlays.get(`${backend}:${threadId}`)]),
      ),
    upsertThreadUsageLine: async ({ line }: { line: ThreadUsageLineRecord }) => {
      usageLines.set(line.usageLineId, line);
      return {
        line,
        summary: {
          backend: line.backend,
          cachedInputTokens: line.cachedInputTokens,
          currency: line.currency,
          inputTokens: line.inputTokens,
          outputTokens: line.outputTokens,
          pricedUsageLineCount: line.priceStatus === "priced" ? 1 : 0,
          provider: line.provider,
          reasoningOutputTokens: line.reasoningOutputTokens,
          threadId: line.parentThreadId ?? line.threadId,
          totalCostMicros: line.totalCostMicros,
          totalTokens: line.totalTokens,
          uncachedInputTokens: line.uncachedInputTokens,
          unpricedUsageLineCount: line.priceStatus === "priced" ? 0 : 1,
          updatedAt: Date.now(),
          usageLineCount: 1,
        },
      };
    },
    completeThreadUsageTurn: async ({
      backend,
      threadId,
      turnId,
      completedAt,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      turnId: string;
      completedAt: number;
    }) => {
      for (const [id, line] of usageLines) {
        if (line.backend === backend && line.threadId === threadId && line.turnId === turnId) {
          usageLines.set(id, { ...line, completedAt });
        }
      }
    },
    readThreadPricing: async ({
      backend,
      threadId,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
    }) => ({
      lines: Array.from(usageLines.values()).filter(
        (line) =>
          line.backend === backend &&
          line.status !== "superseded" &&
          (line.threadId === threadId || line.parentThreadId === threadId),
      ),
      summaries: [],
    }),
    readThreadToolAccounting: async () => toolAccounting,
    upsertThreadMessageOrigin,
    readThreadMessageOrigins: async ({
      backend,
      threadId,
      messageIds,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      messageIds: string[];
    }) =>
      Object.fromEntries(
        messageIds.flatMap((messageId) => {
          const origin = messageOrigins.get(`${backend}:${threadId}:${messageId}`);
          return origin ? [[messageId, origin]] : [];
        }),
      ),
    setAcpWorktreeDirectory: async ({
      backend,
      threadId,
      cwd,
      directory,
    }: {
      backend: string;
      threadId: string;
      cwd: string;
      directory: LinkedDirectorySummary;
    }) => {
      const key = `${backend}:${threadId}`;
      const next = {
        ...overlays.get(key),
        backend,
        threadId,
        executionMode: overlays.get(key)?.executionMode ?? "default",
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
        acpWorktreeDirectory: { cwd, directory },
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    persistThreadUsageActivity: async ({
      backend,
      threadId,
      activity,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      activity: AppServerThreadActivityEntry;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      if (
        !activity.id.startsWith("live-turn-usage-") &&
        !activity.summary.startsWith("Turn usage:") &&
        !activity.summary.startsWith("Monitor usage:")
      ) {
        return { persisted: false };
      }

      const existingActivities = current.immutableUsageActivities ?? [];
      if (existingActivities.some((entry) => entry.id === activity.id)) {
        return { persisted: false };
      }
      overlays.set(key, {
        ...current,
        immutableUsageActivities: [...existingActivities, activity],
      });
      return { persisted: true };
    },
    upsertManagedReviewEntry: async ({
      backend,
      threadId,
      entry,
      pendingContext,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      entry: NonNullable<ThreadOverlayState["managedReviewEntries"]>[number];
      pendingContext?: boolean;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const existingEntries = current.managedReviewEntries ?? [];
      const existingIndex = existingEntries.findIndex(
        (candidate) => candidate.id === entry.id,
      );
      const nextEntries = [...existingEntries];
      if (existingIndex === -1) {
        nextEntries.push(entry);
      } else {
        nextEntries[existingIndex] = entry;
      }
      const next = {
        ...current,
        managedReviewEntries: nextEntries,
        pendingManagedReviewContextEntryIds: pendingContext
          ? [
              ...(current.pendingManagedReviewContextEntryIds ?? []),
              entry.id,
            ].filter((id, index, ids) => ids.indexOf(id) === index)
          : current.pendingManagedReviewContextEntryIds,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    consumeManagedReviewContexts: async ({
      backend,
      threadId,
      entryIds,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      entryIds: string[];
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key);
      if (!current) {
        return undefined;
      }
      const consumed = new Set(entryIds);
      const remaining = (current.pendingManagedReviewContextEntryIds ?? [])
        .filter((id) => !consumed.has(id));
      const next = {
        ...current,
        pendingManagedReviewContextEntryIds:
          remaining.length > 0 ? remaining : undefined,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    upsertThreadSubAgent: async ({
      backend,
      threadId,
      subAgent,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      subAgent: ThreadSubAgentSummary;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        subAgents: [
          subAgent,
          ...(current.subAgents ?? []).filter(
            (entry) => entry.monitorId !== subAgent.monitorId,
          ),
        ].sort((left, right) => right.createdAt - left.createdAt),
      } as MockOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadExecutionMode: async ({
      backend,
      threadId,
      executionMode,
    }: {
      backend: ThreadOverlayState["backend"];
      threadId: string;
      executionMode: "default" | "auto" | "full-access";
    }) => {
      const key = `${backend}:${threadId}`;
      const next = {
        ...overlays.get(key),
        backend,
        threadId,
        executionMode,
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadMessagingPdfToolCatalogVersion: async ({
      backend,
      threadId,
      version,
    }: {
      backend: ThreadOverlayState["backend"];
      threadId: string;
      version: number;
    }) => {
      const key = `${backend}:${threadId}`;
      const next = {
        ...overlays.get(key),
        backend,
        threadId,
        messagingPdfToolCatalogVersion: version,
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadMcpConnectionIds: async ({
      backend,
      threadId,
      connectionIds,
    }: {
      backend: ThreadOverlayState["backend"];
      threadId: string;
      connectionIds: string[];
    }) => {
      const key = `${backend}:${threadId}`;
      const next = {
        ...overlays.get(key),
        backend,
        threadId,
        mcpConnectionIds: connectionIds,
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadArchiveTombstone: async ({
      backend,
      threadId,
      archivedAt,
      restoredAt,
    }: {
      backend: ThreadOverlayState["backend"];
      threadId: string;
      archivedAt?: number;
      restoredAt?: number;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        archiveTombstonedAt: archivedAt,
        archiveRestoredAt: restoredAt ?? current.archiveRestoredAt,
        archiveRetentionStartedAt: restoredAt === undefined ? current.archiveRetentionStartedAt : undefined,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadModelSettings: async (settings: {
      backend: AppServerBackendKind;
      threadId: string;
      model?: string;
      reasoningEffort?: string;
      serviceTier?: string;
      fastMode?: boolean;
      modelMigrationRevision?: string;
      modelSettingsManuallyUpdatedAt?: number;
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const current = overlays.get(key);
      const reasoningEffortsByModel = {
        ...(current?.reasoningEffortsByModel ?? {}),
      };
      if (settings.model && settings.reasoningEffort) {
        reasoningEffortsByModel[settings.model] = settings.reasoningEffort;
      }
      const next = {
        ...current,
        ...settings,
        reasoningEffortsByModel:
          Object.keys(reasoningEffortsByModel).length > 0
            ? reasoningEffortsByModel
            : undefined,
        extraLinkedDirectories: current?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadPrAutoDispatchEnabled: async ({
      backend,
      threadId,
      enabled,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      enabled: boolean;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = { ...current, prAutoDispatchEnabled: enabled };
      overlays.set(key, next);
      return next;
    },
    turnOffCodexFastEverywhere: async () => {
      let threadCount = 0;
      const updatedThreadIds: string[] = [];
      for (const [key, overlay] of overlays) {
        if (overlay.backend !== "codex" || overlay.fastMode !== true) {
          continue;
        }
        overlays.set(key, { ...overlay, fastMode: false });
        updatedThreadIds.push(overlay.threadId);
        threadCount += 1;
      }
      return {
        launchpadCount: 0,
        threadCount,
        updatedThreadIds,
      };
    },
    setThreadParent: async ({
      backend,
      threadId,
      parentThreadId,
      parentThreadBackend,
      parentThreadInstanceId,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      parentThreadId?: string;
      parentThreadBackend?: AppServerBackendKind;
      parentThreadInstanceId?: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        parentThreadId,
        parentThreadBackend,
      parentThreadInstanceId,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadLock: async ({
      backend,
      threadId,
      lock,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      lock: ThreadOverlayState["lock"];
    }) => {
      const key = `${backend}:${threadId}`;
      const { lock: _previous, ...current } = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = (lock ? { ...current, lock } : current) as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadPin: async ({
      backend,
      threadId,
      pinned,
      pinnedRank,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      pinned?: boolean;
      pinnedRank?: string | null;
      prepend?: boolean;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        pinnedRank: pinned === undefined ? pinnedRank?.trim() || undefined
          : pinned ? current.pinnedRank ?? buildPrependPinRank([
            ...[...overlays.values()].map((overlay) => overlay.pinnedRank),
            ...(params?.remotePinnedRanks ?? []),
          ]) : undefined,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setSubthreadsCollapsed: async ({
      backend,
      parentThreadId,
      collapsed,
    }: {
      backend: AppServerBackendKind;
      parentThreadId: string;
      collapsed: boolean;
    }) => {
      const key = `${backend}:${parentThreadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId: parentThreadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next: ThreadOverlayState = {
        ...current,
        subthreadsCollapsed: collapsed,
      };
      overlays.set(key, next);
      return next;
    },
    setThreadScheduledStart: async ({
      backend,
      threadId,
      scheduledStart,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      scheduledStart?: ThreadOverlayState["scheduledStart"];
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        scheduledStart,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    updateSubthreadOrder: async ({
      backend,
      parentThreadId,
      threadIds,
    }: {
      backend: AppServerBackendKind;
      parentThreadId: string;
      threadIds: string[];
    }) => {
      const key = `${backend}:${parentThreadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId: parentThreadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        subthreadOrder: threadIds,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return threadIds;
    },
    setThreadAgent: async (settings: {
      backend: AppServerBackendKind;
      threadId: string;
      agent: ThreadOverlayState["agent"] | null;
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const current = overlays.get(key) ?? {
        backend: settings.backend,
        threadId: settings.threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        agent: settings.agent ?? undefined,
        queuedAgentChange: undefined,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setQueuedThreadAgentChange: async (settings: {
      backend: AppServerBackendKind;
      threadId: string;
      change: ThreadOverlayState["queuedAgentChange"];
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const next = { ...(overlays.get(key) ?? { backend: settings.backend, threadId: settings.threadId, extraLinkedDirectories: [] }), queuedAgentChange: settings.change };
      overlays.set(key, next);
      return next;
    },
    setThreadHandoffOrigin: async (settings: {
      backend: AppServerBackendKind;
      threadId: string;
      handoffOrigin: ThreadOverlayState["handoffOrigin"] | null;
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const current = overlays.get(key) ?? {
        backend: settings.backend,
        threadId: settings.threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        handoffOrigin: settings.handoffOrigin ?? undefined,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadForkOrigin: async (settings: {
      backend: AppServerBackendKind;
      threadId: string;
      forkSourceThreadId?: string;
      forkBaselineCaptured?: boolean;
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const current = overlays.get(key) ?? {
        backend: settings.backend,
        threadId: settings.threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const forkSourceThreadId =
        settings.forkSourceThreadId?.trim() || current.forkSourceThreadId;
      const next = {
        ...current,
        ...(forkSourceThreadId ? { forkSourceThreadId } : {}),
        ...(settings.forkBaselineCaptured !== undefined
          ? { forkBaselineCaptured: settings.forkBaselineCaptured }
          : {}),
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadCodexEnvironmentRuntime: async (settings: {
      backend: AppServerBackendKind;
      threadId: string;
      codexEnvironmentRuntime?: ThreadOverlayState["codexEnvironmentRuntime"];
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const next = {
        ...overlays.get(key),
        backend: settings.backend,
        threadId: settings.threadId,
        codexEnvironmentRuntime: settings.codexEnvironmentRuntime,
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    listThreadOverlaysWithCodexEnvironmentRuntime: async () => {
      return Array.from(overlays.values()).filter(
        (overlay) => overlay.codexEnvironmentRuntime !== undefined,
      );
    },
    setThreadExpectedBranch: async ({
      backend,
      threadId,
      branch,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      branch: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        gitBranch: branch,
        observedGitBranch: branch,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadObservedBranch: async ({
      backend,
      threadId,
      branch,
      expectedBranch,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      branch?: string;
      expectedBranch?: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const previousObservedBranch = current.observedGitBranch?.trim();
      const nextObservedBranch = branch?.trim();
      const fallbackExpectedBranch =
        !current.gitBranch?.trim() &&
        previousObservedBranch &&
        nextObservedBranch &&
        previousObservedBranch !== nextObservedBranch
          ? previousObservedBranch
          : undefined;
      const requestedExpectedBranch = expectedBranch?.trim() || undefined;
      const next = {
        ...current,
        gitBranch: requestedExpectedBranch
          ?? (current.gitBranch?.trim() ? current.gitBranch : fallbackExpectedBranch),
        observedGitBranch: branch,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    retainThreadBranchDrift: async ({
      backend,
      threadId,
      expectedBranch,
      observedBranch,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      expectedBranch: string;
      observedBranch: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        retainedBranchDriftPairs: [
          ...(current.retainedBranchDriftPairs ?? []),
          {
            expectedBranch,
            observedBranch,
            retainedAt: Date.now(),
          },
        ],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    getLaunchpadDefaults: async () => launchpadDefaults,
    setLaunchpadDefaults: async (
      patch: Partial<NavigationLaunchpadDefaults>,
      options?: { provider?: AppServerBackendKind },
    ) => {
      launchpadDefaults = applyNavigationLaunchpadDefaultsPatch(
        launchpadDefaults,
        patch,
        options?.provider ?? launchpadDefaults.backend,
      );
      return launchpadDefaults;
    },
    getDirectoryLaunchpad: async ({ directoryKey }: { directoryKey: string }) =>
      launchpads.get(directoryKey),
    listDirectoryLaunchpads: async () => Array.from(launchpads.values()),
    upsertDirectoryLaunchpad: async (launchpad: NavigationLaunchpadDraft) => {
      const nextLaunchpad = {
        ...launchpads.get(launchpad.directoryKey),
        ...launchpad,
      };
      launchpads.set(launchpad.directoryKey, nextLaunchpad);
      return nextLaunchpad;
    },
    resetDirectoryLaunchpad: async ({ directoryKey }: { directoryKey: string }) => {
      launchpads.delete(directoryKey);
    },
    replaceWorkspaceLinkedDirectory: async ({
      backend,
      threadId,
      directory,
      gitBranch,
      retainWorktree,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      directory: ThreadOverlayState["extraLinkedDirectories"][number];
      gitBranch?: string;
      retainWorktree?: ThreadOverlayState["extraLinkedDirectories"][number];
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const retainedWorktrees = [
        ...((current as ThreadOverlayState).retainedWorktrees ?? []).filter((retained) =>
          retained.worktreePath !== directory.worktreePath
          && retained.worktreePath !== retainWorktree?.worktreePath),
        ...(retainWorktree ? [retainWorktree] : []),
      ];
      const next = {
        ...current,
        gitBranch: gitBranch ?? current.gitBranch,
        observedGitBranch: gitBranch ?? current.observedGitBranch,
        extraLinkedDirectories: [directory],
        retainedWorktrees: retainedWorktrees.length > 0 ? retainedWorktrees : undefined,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    addLinkedDirectory: async ({
      backend,
      threadId,
      directory,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      directory: ThreadOverlayState["extraLinkedDirectories"][number];
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        extraLinkedDirectories: [
          ...current.extraLinkedDirectories.filter(
            (candidate) => candidate.id !== directory.id,
          ),
          directory,
        ],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    removeLinkedDirectory: async ({
      backend,
      threadId,
      directory,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      directory: ThreadOverlayState["extraLinkedDirectories"][number];
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        extraLinkedDirectories: current.extraLinkedDirectories.filter(
          (candidate) => candidate.id !== directory.id,
        ),
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    addThreadPullRequestReference: async ({
      backend,
      threadId,
      pr,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      pr: import("@pwragent/shared/contracts/navigation").PrSummary;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        prs: [
          ...(current.prs ?? []).filter(
            (candidate) =>
              !(
                candidate.provider.toLowerCase() === pr.provider.toLowerCase() &&
                candidate.org.toLowerCase() === pr.org.toLowerCase() &&
                candidate.repo.toLowerCase() === pr.repo.toLowerCase() &&
                candidate.number === pr.number
              ),
          ),
          pr,
        ],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    upsertWorktreeSnapshot: async ({
      backend,
      threadId,
      snapshot,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      snapshot: WorktreeSnapshotSummary;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        worktreeSnapshots: [
          ...(current.worktreeSnapshots ?? []).filter(
            (candidate) => candidate.id !== snapshot.id
          ),
          snapshot,
        ],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    appendPermissionTransition: async ({
      backend,
      threadId,
      transition,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      transition: import("@pwragent/shared/contracts/navigation").ThreadPermissionTransition;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const nextLog = [
        ...(current.permissionTransitionLog ?? []),
        transition,
      ];
      const trimmed =
        nextLog.length > 100 ? nextLog.slice(nextLog.length - 100) : nextLog;
      const next = {
        ...current,
        permissionTransitionLog: trimmed,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    appendMessagingBindingTransition: async ({
      backend,
      threadId,
      transition,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      transition: import("@pwragent/shared/contracts/navigation").ThreadMessagingBindingTransition;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const nextLog = [
        ...(current.messagingBindingTransitionLog ?? []),
        transition,
      ];
      const trimmed =
        nextLog.length > 100 ? nextLog.slice(nextLog.length - 100) : nextLog;
      const next = {
        ...current,
        messagingBindingTransitionLog: trimmed,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    appendTurnFailure: async ({
      backend,
      threadId,
      failure,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      failure: import("@pwragent/shared/contracts/navigation").ThreadTurnFailure;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      if (
        (current.turnFailureLog ?? []).some(
          (entry) => entry.turnId === failure.turnId,
        )
      ) {
        return current;
      }
      const nextLog = [...(current.turnFailureLog ?? []), failure];
      const trimmed =
        nextLog.length > 100 ? nextLog.slice(nextLog.length - 100) : nextLog;
      const next = {
        ...current,
        turnFailureLog: trimmed,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setTurnFailureCodexInvalidIdRecovery: async ({
      threadId,
      turnId,
      recovery,
    }: {
      threadId: string;
      turnId: string;
      recovery: NonNullable<
        import("@pwragent/shared/contracts/navigation").ThreadTurnFailure["codexInvalidIdRecovery"]
      >;
    }) => {
      const key = `codex:${threadId}`;
      const current = overlays.get(key);
      const failureIndex = current?.turnFailureLog?.findIndex(
        (entry) => entry.turnId === turnId,
      ) ?? -1;
      if (!current || failureIndex === -1) {
        throw new Error(
          `Cannot record Codex invalid-ID recovery without failed turn ${turnId}`,
        );
      }
      const nextLog = [...current.turnFailureLog!];
      nextLog[failureIndex] = {
        ...nextLog[failureIndex]!,
        codexInvalidIdRecovery: recovery,
      };
      const next = {
        ...current,
        codexInvalidIdRecoveryLastAttemptedAt: recovery.attemptedAt,
        turnFailureLog: nextLog,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    appendQuestionnaireActivity: async ({
      backend,
      threadId,
      activity,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      activity: NonNullable<ThreadOverlayState["questionnaireActivityLog"]>[number];
    }) => {
      const key = `${backend}:${threadId}`;
      const current: ThreadOverlayState = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      if (
        (current.questionnaireActivityLog ?? []).some(
          (entry) => entry.requestId === activity.requestId,
        )
      ) {
        return current;
      }
      const nextLog = [
        ...(current.questionnaireActivityLog ?? []),
        activity,
      ].sort((left, right) => left.createdAt - right.createdAt);
      const next = {
        ...current,
        questionnaireActivityLog: nextLog,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    appendThreadRewind: async ({
      backend,
      threadId,
      rewind,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      rewind: NonNullable<ThreadOverlayState["rewindLog"]>[number];
    }) => {
      const key = `${backend}:${threadId}`;
      const current: ThreadOverlayState = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      const next = { ...current, rewindLog: [...current.rewindLog ?? [], rewind] } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    markThreadRewindUndone: async ({
      backend,
      threadId,
      rewindId,
      undoneAt,
    }: {
      backend: AppServerBackendKind;
      threadId: string;
      rewindId: string;
      undoneAt: number;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key);
      if (!current) return current;
      const next = {
        ...current,
        rewindLog: current.rewindLog?.map((entry) => entry.id === rewindId
          ? { ...entry, undoable: false, undoneAt }
          : entry),
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
  } as unknown as MockOverlayStore;
}

export const TEST_TASK_MONITOR_MODELS: BackendModelOption[] = [
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    supportsReasoning: true,
  },
];

export class MockBackendClient {
  private readonly listeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();
  private readonly unexpectedExitListeners = new Set<() => void>();
  private readonly requestListeners = new Set<
    (request: AppServerPendingRequestNotification) => Promise<unknown> | unknown
  >();
  lastReadThreadParams?: {
    threadId: string;
    before?: string;
    includeTurns?: boolean;
    limit?: number;
  };
  readThreadCalls: Array<{
    threadId: string;
    before?: string;
    includeTurns?: boolean;
    limit?: number;
  }> = [];
  injectedThreadItems: Array<{ threadId: string; items: unknown[] }> = [];
  lastStartThreadParams?: {
    cwd?: string;
    dynamicTools?: unknown;
    ephemeral?: boolean;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadStartParams["config"];
    defaultModeRequestUserInput?: boolean;
    threadSource?: CodexThreadSource;
    pwrdrvrTokenMiser?: CodexPwrdrvrTokenMiserActivation;
  };
  lastForkThreadParams?: {
    threadId: string;
    path?: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadForkParams["config"];
  };
  lastStartTurnParams?: {
    parentTurnId?: string;
    rootTurnId?: string;
    backend?: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    executionMode?: "default" | "auto" | "full-access";
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadStartParams["config"];
    defaultModeRequestUserInput?: boolean;
    dynamicTools?: unknown;
    pwrdrvrTokenMiser?: CodexPwrdrvrTokenMiserActivation | null;
  };
  interruptTurnCallCount = 0;
  lastInterruptTurnParams?: {
    threadId: string;
    turnId: string;
  };
  startTurnCalls: Array<NonNullable<MockBackendClient["lastStartTurnParams"]>> = [];
  startTurnCallCount = 0;
  closeCallCount = 0;
  invalidIdRecoveryCalls: Array<{
    failureMessage: string;
    forkLineageThreadIds?: string[];
    threadId: string;
  }> = [];
  lastSteerTurnParams?: {
    threadId: string;
    input: AppServerTurnInputItem[];
    expectedTurnId: string;
  };
  lastStartReviewParams?: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: "inline" | "detached";
    model?: string;
    serviceTier?: string | null;
    reasoningEffort?: string;
    fastMode?: boolean;
    cwd?: string;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadStartParams["config"];
    dynamicTools?: unknown;
  };
  lastCompactThreadParams?: Parameters<CodexAppServerClient["compactThread"]>[0];
  lastListMcpServersParams?: {
    threadId?: string;
    detail: "toolsAndAuthOnly" | "full";
  };
  reloadMcpConfigCallCount = 0;
  lastMcpServerOAuthLoginParams?: { name: string };
  lastRemoveMcpServerParams?: { name: string };
  lastArchiveThreadParams?: {
    threadId: string;
  };
  lastRestoreThreadParams?: {
    threadId: string;
  };
  lastRenameThreadParams?: {
    threadId: string;
    name: string;
  };
  lastUpdateThreadMetadataParams?: {
    threadId: string;
    gitInfo?: {
      branch?: string | null;
      originUrl?: string | null;
      sha?: string | null;
    } | null;
  };
  lastUpdateThreadWorkspaceParams?: {
    threadId: string;
    cwd: string;
  };
  lastSetThreadPermissionsParams?: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  lastTrustProjectParams?: {
    projectPath: string;
    configPath?: string;
  };
  listThreadsCallCount = 0;
  listNativeSubAgentThreadsCallCount = 0;
  initializeCallCount = 0;
  listModelsCallCount = 0;
  readServerCapabilitiesCallCount = 0;
  readRateLimitsCallCount = 0;
  steerTurnCallCount = 0;
  setThreadPermissionsCallCount = 0;
  lastListModelsDiagnostics?: {
    callerReason?: string;
    ownerId?: string;
  };
  lastListThreadsDiagnostics?: {
    callerReason?: string;
    ownerId?: string;
  };
  lastListThreadsParams?: {
    archived?: boolean;
    enrichDirectories?: boolean;
    filter?: string;
  };
  lastListNativeSubAgentThreadsParams?: {
    filter?: string;
    limit?: number;
    maxPages?: number;
  };
  listThreadsCalls: Array<{
    diagnostics?: {
      callerReason?: string;
      ownerId?: string;
    };
    params?: {
      archived?: boolean;
      enrichDirectories?: boolean;
      filter?: string;
    };
  }> = [];

  constructor(
    private readonly options: {
      initializeResult?: {
        serverInfo?: {
          name?: string;
          version?: string;
        };
        methods?: string[];
        userAgent?: string;
      };
      initializeError?: Error;
      serverCapabilities?: CodexServerCapabilities;
      serverCapabilitiesError?: Error;
      serverCapabilitiesErrors?: Array<Error | undefined>;
      threads?: AppServerThreadSummary[];
      nativeSubAgentThreads?: AppServerThreadSummary[];
      replay?: AppServerThreadReplay;
      readThreadReplays?: AppServerThreadReplay[];
      readThreadError?: Error;
      readThreadErrorsByThreadId?: Record<string, Error>;
      readThreadDelay?: Promise<unknown>;
      skills?: Array<{
        commands?: AppServerAvailableCommandSummary[];
        cwd?: string;
        skills: AppServerSkillSummary[];
      }>;
      models?: BackendModelOption[];
      modelListErrors?: Error[];
      account?: BackendAccountSummary;
      rateLimits?: BackendRateLimitSummary[];
      rateLimitReadDelays?: Array<Promise<unknown> | undefined>;
      rateLimitReads?: BackendRateLimitSummary[][];
      listThreadsError?: Error;
      listThreadsDelay?: Promise<unknown>;
      respectThreadTitleFilter?: boolean;
      archivedThreads?: AppServerThreadSummary[];
      archiveThreadError?: Error;
      startThreadResult?: { threadId: string };
      startTurnDelay?: Promise<unknown>;
      startTurnError?: Error;
      startTurnErrors?: Array<Error | undefined>;
      startTurnResults?: Array<{ threadId: string; turnId: string }>;
      invalidIdRecoveryResult?: {
        backupPath: string;
        removedMessageIdCount: number;
        rolloutPath: string;
        threadId: string;
      };
      invalidIdRecoveryDelay?: Promise<unknown>;
      invalidIdRecoveryError?: Error;
      invalidIdRecoveryBlockingTurns?: Array<{ threadId: string; turnId?: string }>;
      invalidIdRecoveryWaitsForAbort?: boolean;
      steerTurnError?: Error;
      interruptEndsTurn?: boolean;
      setThreadPermissionsError?: Error;
      setThreadPermissionsDelay?: Promise<unknown>;
      startReviewResult?: {
        threadId: string;
        reviewThreadId: string;
        turnId: string;
      };
      startReviewDelay?: Promise<unknown>;
      startReviewError?: Error;
      updateThreadWorkspaceError?: Error;
      codexHome?: string;
    }
  ) {}

  async close(): Promise<void> {
    this.closeCallCount += 1;
  }

  async getInitializeResult() {
    this.initializeCallCount += 1;
    if (this.options.initializeError) {
      throw this.options.initializeError;
    }

    return this.options.initializeResult ?? {};
  }

  async readServerCapabilities() {
    this.readServerCapabilitiesCallCount += 1;
    const sequencedError = this.options.serverCapabilitiesErrors?.shift();
    if (sequencedError) {
      throw sequencedError;
    }
    if (this.options.serverCapabilitiesError) {
      throw this.options.serverCapabilitiesError;
    }
    return this.options.serverCapabilities ?? {
      codeModeOutputReducer: {
        modelGuidance: {
          version: 1,
          toolDescriptionConfigKey:
            "features.code_mode.output_reducer.tool_description_guidance",
          continuationConfigKey:
            "features.code_mode.output_reducer.continuation_guidance",
          modelVisibleOverheadRequestField:
            "model_visible_overhead_characters",
        },
        protocolVersion: 1,
      },
    };
  }

  async readConfiguredMcpServerNames(): Promise<string[]> {
    return [];
  }

  async readCodexHome(): Promise<string> {
    return this.options.codexHome ?? "/home/example/.codex";
  }

  async listThreads(params?: {
    archived?: boolean;
    enrichDirectories?: boolean;
    filter?: string;
    limit?: number;
    maxPages?: number;
    skipArchivedMetadataRefresh?: boolean;
  }, diagnostics?: { callerReason?: string; ownerId?: string }): Promise<AppServerThreadSummary[]> {
    this.listThreadsCallCount += 1;
    this.lastListThreadsDiagnostics = diagnostics;
    this.lastListThreadsParams = params;
    this.listThreadsCalls.push({ diagnostics, params });
    if (this.options.listThreadsError) {
      throw this.options.listThreadsError;
    }
    if (this.options.listThreadsDelay) {
      await this.options.listThreadsDelay;
    }
    const threads =
      params?.archived === true && this.options.archivedThreads
        ? this.options.archivedThreads
        : this.options.threads ?? [];
    const filter = params?.filter?.trim().toLowerCase();
    return this.options.respectThreadTitleFilter && filter
      ? threads.filter((thread) => thread.title.toLowerCase().includes(filter))
      : threads;
  }

  async listNativeSubAgentThreads(params?: {
    ancestorThreadId?: string;
    filter?: string;
    limit?: number;
  }): Promise<AppServerThreadSummary[]> {
    this.listNativeSubAgentThreadsCallCount += 1;
    this.lastListNativeSubAgentThreadsParams = params;
    return this.options.nativeSubAgentThreads ?? [];
  }

  setThreads(threads: AppServerThreadSummary[]): void {
    this.options.threads = threads;
  }

  async archiveThread(params: { threadId: string }): Promise<{ threadId: string }> {
    this.lastArchiveThreadParams = params;
    if (this.options.archiveThreadError) {
      throw this.options.archiveThreadError;
    }
    return { threadId: params.threadId };
  }

  async restoreThread(params: { threadId: string }): Promise<{ threadId: string }> {
    this.lastRestoreThreadParams = params;
    return { threadId: params.threadId };
  }

  async renameThread(params: { threadId: string; name: string }): Promise<{ threadId: string }> {
    this.lastRenameThreadParams = params;
    return { threadId: params.threadId };
  }

  async updateThreadMetadata(params: {
    threadId: string;
    gitInfo?: {
      branch?: string | null;
      originUrl?: string | null;
      sha?: string | null;
    } | null;
  }): Promise<{ threadId: string }> {
    this.lastUpdateThreadMetadataParams = params;
    return { threadId: params.threadId };
  }

  async updateThreadWorkspace(params: {
    threadId: string;
    cwd: string;
  }): Promise<{ threadId: string }> {
    this.lastUpdateThreadWorkspaceParams = params;
    if (this.options.updateThreadWorkspaceError) {
      throw this.options.updateThreadWorkspaceError;
    }
    return { threadId: params.threadId };
  }

  async listSkills(): Promise<Array<{
    commands?: AppServerAvailableCommandSummary[];
    cwd?: string;
    skills: AppServerSkillSummary[];
  }>> {
    return this.options.skills ?? [];
  }

  // The real client's rule over this mock's catalog, without a catalog read.
  async resolveHelperModelSelection(params: { helper: HelperModelId }) {
    return resolveHelperModel({ helper: params.helper, models: this.options.models ?? [] });
  }

  async listModels(diagnostics?: { callerReason?: string; ownerId?: string }) {
    this.listModelsCallCount += 1;
    this.lastListModelsDiagnostics = diagnostics;
    const error = this.options.modelListErrors?.shift();
    if (error) {
      throw error;
    }
    return this.options.models ?? [];
  }

  async readAccount(): Promise<BackendAccountSummary> {
    return this.options.account ?? {};
  }

  async readRateLimits(): Promise<BackendRateLimitSummary[]> {
    this.readRateLimitsCallCount += 1;
    const rateLimits =
      this.options.rateLimitReads?.shift() ?? this.options.rateLimits ?? [];
    const delay = this.options.rateLimitReadDelays?.shift();
    if (delay) {
      await delay;
    }
    return rateLimits;
  }

  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onAppServerUnexpectedExit(listener: () => void): () => void {
    this.unexpectedExitListeners.add(listener);
    return () => {
      this.unexpectedExitListeners.delete(listener);
    };
  }

  emitUnexpectedExit(): void {
    for (const listener of this.unexpectedExitListeners) listener();
  }

  onRequest(
    listener: (request: AppServerPendingRequestNotification) => Promise<unknown> | unknown
  ): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  async readThread(_params?: {
    threadId: string;
    before?: string;
    includeTurns?: boolean;
    limit?: number;
  }): Promise<AppServerThreadReplay> {
    this.lastReadThreadParams = _params;
    if (_params) {
      this.readThreadCalls.push(_params);
    }
    const replay = this.options.readThreadReplays?.shift();
    if (this.options.readThreadDelay) {
      await this.options.readThreadDelay;
    }
    const readThreadError =
      (_params
        ? this.options.readThreadErrorsByThreadId?.[_params.threadId]
        : undefined)
      ?? this.options.readThreadError;
    if (readThreadError) {
      throw readThreadError;
    }
    if (replay) {
      return replay;
    }
    return this.options.replay ?? {
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    };
  }

  refreshThreadTools = vi.fn(async (_params: Parameters<CodexAppServerClient["refreshThreadTools"]>[0]): Promise<void> => {});

  async injectThreadItems(params: { threadId: string; items: unknown[] }): Promise<void> {
    this.injectedThreadItems.push(params);
  }

  async startThread(params?: {
    cwd?: string;
    dynamicTools?: unknown;
    ephemeral?: boolean;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadStartParams["config"];
    defaultModeRequestUserInput?: boolean;
    threadSource?: CodexThreadSource;
    pwrdrvrTokenMiser?: CodexPwrdrvrTokenMiserActivation;
  }): Promise<{ threadId: string }> {
    this.lastStartThreadParams = params;
    return this.options.startThreadResult ?? { threadId: "thread-1" };
  }

  async forkThread(params: {
    threadId: string;
    path?: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadForkParams["config"];
  }): Promise<{ threadId: string }> {
    this.lastForkThreadParams = params;
    return { threadId: "thread-fork" };
  }

  async startTurn(params: {
    parentTurnId?: string;
    rootTurnId?: string;
    backend?: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    executionMode?: "default" | "auto" | "full-access";
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: unknown;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadStartParams["config"];
    defaultModeRequestUserInput?: boolean;
    dynamicTools?: unknown;
    pwrdrvrTokenMiser?: CodexPwrdrvrTokenMiserActivation | null;
  }): Promise<{ threadId: string; turnId: string }> {
    this.startTurnCallCount += 1;
    await this.options.startTurnDelay;
    const sequencedError = this.options.startTurnErrors?.shift();
    if (sequencedError) {
      throw sequencedError;
    }
    if (this.options.startTurnError) {
      throw this.options.startTurnError;
    }
    this.lastStartTurnParams = params;
    this.startTurnCalls.push(params);
    return this.options.startTurnResults?.shift() ?? {
      threadId: params.threadId,
      turnId: "turn-1",
    };
  }

  async recoverInvalidPersistedResponseMessageIds(params: {
    failureMessage: string;
    forkLineageThreadIds?: string[];
    onWaitingForTurns?: (
      turns: Array<{ threadId: string; turnId?: string }>,
    ) => void | Promise<void>;
    signal?: AbortSignal;
    threadId: string;
  }): Promise<{
    backupPath: string;
    removedMessageIdCount: number;
    rolloutPath: string;
    threadId: string;
  }> {
    const { onWaitingForTurns, signal, ...call } = params;
    this.invalidIdRecoveryCalls.push(call);
    if (this.options.invalidIdRecoveryBlockingTurns) {
      await onWaitingForTurns?.(this.options.invalidIdRecoveryBlockingTurns);
    }
    if (this.options.invalidIdRecoveryWaitsForAbort) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("abandoned while waiting");
    }
    await this.options.invalidIdRecoveryDelay;
    if (this.options.invalidIdRecoveryError) {
      throw this.options.invalidIdRecoveryError;
    }
    return this.options.invalidIdRecoveryResult ?? {
      backupPath: "/codex/sessions/thread.backup.jsonl",
      removedMessageIdCount: 1,
      rolloutPath: "/codex/sessions/thread.jsonl",
      threadId: params.threadId,
    };
  }

  async startReview(params: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: "inline" | "detached";
    model?: string;
    serviceTier?: string | null;
    reasoningEffort?: string;
    fastMode?: boolean;
    cwd?: string;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    config?: CodexThreadStartParams["config"];
    dynamicTools?: unknown;
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> {
    this.lastStartReviewParams = params;
    await this.options.startReviewDelay;
    if (this.options.startReviewError) {
      throw this.options.startReviewError;
    }
    return this.options.startReviewResult ?? {
      threadId: params.threadId,
      reviewThreadId: params.threadId,
      turnId: "turn-review-1",
    };
  }

  setTurnApprovalReviewer = vi.fn(async (_params: {
    threadId: string;
    turnId: string;
    approvalsReviewer: "user" | "auto_review";
  }): Promise<{ status: "applied" | "targetUnavailable" }> => ({ status: "applied" }));

  async setThreadPermissions(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
  }): Promise<{ threadId: string }> {
    this.lastSetThreadPermissionsParams = params;
    this.setThreadPermissionsCallCount += 1;
    await this.options.setThreadPermissionsDelay;
    if (this.options.setThreadPermissionsError) {
      throw this.options.setThreadPermissionsError;
    }

    return {
      threadId: params.threadId,
    };
  }

  async interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    this.interruptTurnCallCount += 1;
    this.lastInterruptTurnParams = params;
    // Codex answers turn/interrupt by ending the turn with status
    // interrupted. Without that answer, close() waits out the whole
    // shutdown-stop deadline for each turn a test leaves running. Tests that
    // script their own terminal after the interrupt leave this off.
    if (this.options.interruptEndsTurn) {
      await this.emit({
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          turn: { id: params.turnId, status: "interrupted", output: [] },
        },
      } as never);
    }
    return params;
  }

  async steerTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    expectedTurnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    this.steerTurnCallCount += 1;
    this.lastSteerTurnParams = params;
    if (this.options.steerTurnError) {
      throw this.options.steerTurnError;
    }

    return { threadId: params.threadId, turnId: params.expectedTurnId };
  }

  async compactThread(params: Parameters<CodexAppServerClient["compactThread"]>[0]): Promise<{ threadId: string; turnId: string; itemId: string }> {
    this.lastCompactThreadParams = params;
    return {
      threadId: params.threadId,
      turnId: "compact-turn-1",
      itemId: "compact-item-1",
    };
  }

  async listMcpServers(params: {
    threadId?: string;
    detail: "toolsAndAuthOnly" | "full";
  }) {
    this.lastListMcpServersParams = params;
    return [
      {
        name: "atlassian-rovo",
        authStatus: "oAuth" as const,
        tools: ["fetch", "search"],
      },
    ];
  }

  async reloadMcpConfig(): Promise<void> {
    this.reloadMcpConfigCallCount += 1;
  }

  async startMcpServerOAuthLogin(params: {
    name: string;
  }): Promise<{ authorizationUrl: string }> {
    this.lastMcpServerOAuthLoginParams = params;
    return { authorizationUrl: "https://example.test/oauth" };
  }

  async removeMcpServer(params: { name: string }): Promise<void> {
    this.lastRemoveMcpServerParams = params;
  }

  async trustProject(params: {
    projectPath: string;
    configPath?: string;
  }): Promise<{ projectPath: string; configPath?: string }> {
    this.lastTrustProjectParams = params;
    return params;
  }

  async emit(notification: AppServerNotification): Promise<void> {
    for (const listener of this.listeners) {
      await listener(notification);
    }
  }

  async emitRequest(request: AppServerPendingRequestNotification): Promise<unknown> {
    const listener = this.requestListeners.values().next().value;
    if (!listener) {
      throw new Error("No request listener registered");
    }
    return await listener(request);
  }
}

export function createMessagingArchiveCleanupStoreMock(options?: {
  bindings?: Array<{
    backend?: AppServerBackendKind;
    channel?: "telegram" | "discord";
    conversationKind?: MessagingBindingRecord["channel"]["conversation"]["kind"];
    conversationTitle?: string;
    id: string;
    parentTitle?: string;
    targetKind?: MessagingBindingRecord["targetKind"];
    threadId: string;
    updatedAt?: number;
  }>;
  pendingIntentIds?: string[];
}) {
  const revokedBindingIds: string[] = [];
  const deletedPendingThreads: Array<{ backend: AppServerBackendKind; threadId: string }> = [];
  const bindings = new Map<string, MessagingBindingRecord>(
    (options?.bindings ?? []).map((binding) => [
      binding.id,
      {
        id: binding.id,
        backend: binding.backend ?? "codex",
        threadId: binding.threadId,
        channel: {
          channel: binding.channel ?? "telegram",
          conversation: {
            kind: binding.conversationKind ?? "dm",
            id: `${binding.id}:conversation`,
            title: binding.conversationTitle ?? `${binding.id} conversation`,
            parentTitle: binding.parentTitle,
          },
        },
        authorizedActorIds: [`${binding.id}:actor`],
        createdAt: 1,
        targetKind: binding.targetKind,
        updatedAt: binding.updatedAt ?? 1,
      },
    ]),
  );

  return {
    revokedBindingIds,
    deletedPendingThreads,
    async findActiveBindingsForThread(params: {
      backend: AppServerBackendKind;
      threadId: string;
    }) {
      return [...bindings.values()].filter(
        (binding) => !binding.revokedAt && isBindingForThread(binding, params),
      );
    },
    async findActiveBindingsForBackend(params: {
      backend: AppServerBackendKind;
    }) {
      return [...bindings.values()].filter(
        (binding) =>
          !binding.revokedAt &&
          (!binding.backend || binding.backend === params.backend),
      );
    },
    async revokeBinding(params: { bindingId: string; revokedAt?: number }) {
      const binding = bindings.get(params.bindingId);
      if (!binding) return undefined;
      const revokedAt = params.revokedAt ?? Date.now();
      const revoked = {
        ...binding,
        revokedAt,
        updatedAt: revokedAt,
      };
      bindings.set(params.bindingId, revoked);
      revokedBindingIds.push(params.bindingId);
      return revoked;
    },
    async deletePendingIntentsForThread(params: {
      backend: AppServerBackendKind;
      threadId: string;
    }) {
      deletedPendingThreads.push(params);
      return params.threadId === "thread-1" ? options?.pendingIntentIds ?? [] : [];
    },
  };
}

export function createMessagingArchiveCleanerMock(
  result:
    | Promise<{ notifiedCount: number; revokedCount: number }>
    | { notifiedCount: number; revokedCount: number } = {
    notifiedCount: 1,
    revokedCount: 1,
  },
) {
  const requests: Array<{
    backend: AppServerBackendKind;
    threadId: string;
    origin: "thread-archive";
  }> = [];

  return {
    requests,
    async requestBindingRevokeAllForThread(request: {
      backend: AppServerBackendKind;
      threadId: string;
      origin: "thread-archive";
    }) {
      requests.push(request);
      return result;
    },
  };
}

export function createAcpAgentStoreMock(records: AcpInstalledAgentRecord[]) {
  return {
    getInstalledAgent: (backendId: AcpBackendId) =>
      records.find((record) => record.backendId === backendId),
    listInstalledAgents: () => records,
    upsertInstalledAgent: (record: AcpInstalledAgentRecord) => {
      const index = records.findIndex(
        (candidate) => candidate.backendId === record.backendId,
      );
      if (index >= 0) {
        records[index] = record;
      } else {
        records.push(record);
      }
    },
  };
}

export function createAcpSessionStoreMock(records: AcpSessionMetadata[]) {
  return {
    listSessions: (
      backendId: string,
      params?: { archived?: boolean; includeHidden?: boolean },
    ) =>
      records.filter(
        (record) =>
          record.backendId === backendId &&
          (params?.includeHidden === true || !record.hidden) &&
          Boolean(record.archivedAt) === (params?.archived === true),
      ),
    getSession: (backendId: string, sessionId: string) =>
      records.find(
        (record) =>
          record.backendId === backendId && record.sessionId === sessionId,
      ),
    upsertSession: (metadata: AcpSessionMetadata) => {
      const index = records.findIndex(
        (record) =>
          record.backendId === metadata.backendId &&
          record.sessionId === metadata.sessionId,
      );
      if (index === -1) {
        records.push(metadata);
      } else {
        records[index] = metadata;
      }
    },
  };
}

export function createKimiAgentRecord(
  backendId: AcpBackendId = "acp:kimi" as AcpBackendId,
  runtimeCapabilities?: BackendAcpRuntimeCapabilities,
): AcpInstalledAgentRecord {
  return {
    backendId,
    registryId: "kimi",
    name: "Kimi Code CLI",
    version: "1.44.0",
    distributionKind: "local",
    distributionSource: "kimi acp",
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    allowlistRuleId: "local-kimi-cli",
    installedAt: 1000,
    updatedAt: 2000,
    ...(runtimeCapabilities ? { runtimeCapabilities } : {}),
    launchDescriptor: {
      backendId,
      registryId: "kimi",
      distributionKind: "local",
      command: "kimi",
      args: ["acp"],
      env: {},
    },
  };
}

export const KIMI_HIGHSPEED_MODEL = "kimi-code/kimi-for-coding-highspeed";
export const KIMI_K3_MODEL = "kimi-code/k3";

/**
 * Kimi Code 2.0.0's shape: the model is a config option, and the model decides
 * which thought levels exist. Highspeed offers only `on`, K3 offers low/high/
 * max, and Kimi refuses any other level with -32602.
 */
export function createKimiModelCapabilities(
  currentModelId: string = KIMI_HIGHSPEED_MODEL,
): BackendAcpRuntimeCapabilities {
  return {
    schemaVersion: 1,
    status: "discovered",
    source: "session-load",
    configOptions: [
      {
        id: "model",
        label: "Model",
        type: "select",
        category: "model",
        currentValue: currentModelId,
        values: [{ value: KIMI_HIGHSPEED_MODEL }, { value: KIMI_K3_MODEL }],
      },
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        category: "thought_level",
        currentValue: "on",
        values: [{ value: "on" }],
      },
    ],
    models: {
      currentModelId,
      availableModels: [
        {
          id: KIMI_HIGHSPEED_MODEL,
          label: "K2.7 Coding Highspeed",
          supportsReasoning: true,
          reasoningEfforts: ["on"],
          defaultReasoningEffort: "on",
        },
        {
          id: KIMI_K3_MODEL,
          label: "K3",
          supportsReasoning: true,
          reasoningEfforts: ["low", "high", "max"],
          defaultReasoningEffort: "high",
        },
      ],
    },
  };
}

type KimiSendControlPrompt = (params: {
  sessionId: string;
  prompt: string;
}) => Promise<{ text: string }>;

type KimiStartSession = (params: {
  acpRuntime?: BackendAcpSessionRuntimeState;
  cwd?: string;
  executionMode: "default" | "auto" | "full-access";
  hidden?: boolean;
  title?: string;
}) => Promise<AcpSessionMetadata>;

export type KimiStartPrompt = (params: {
  sessionId: string;
  prompt: string;
  promptContent?: unknown[];
  parts?: unknown[];
  turnId?: string;
}) => { sessionId: string; turnId: string } | Promise<{ sessionId: string; turnId: string }>;

type AcpSteerSession = (params: {
  sessionId: string;
  text: string;
  content: unknown[];
  interjectionId: string;
}) => Promise<{ delivery: "currentTurn" | "nextTurn" }>;

export type AcpRewindSession = (params: {
  sessionId: string;
  targetPromptIndex: number;
}) => Promise<{ promptText?: string; updatedAt: number }>;

export type AcpListRewindPoints = (sessionId: string) => Promise<Array<{
  promptIndex: number;
  fileSnapshotCount: number;
  hasFileChanges: boolean;
  promptPreview: string;
}>>;

type AcpConfigureWorkflowBudget = (params: {
  sessionId: string;
  defaultAgentBudget?: number;
  maxAgentBudget?: number;
}) => Promise<{ defaultAgentBudget: number; maxAgentBudget: number }>;

export function createKimiAcpRegistry(options?: {
  correspondenceStore?: ThreadCorrespondenceStore;
  acpBackendId?: AcpBackendId;
  installedAgent?: AcpInstalledAgentRecord;
  acpRolloutStore?: AcpRolloutStore;
  sessionId?: string;
  sessions?: AcpSessionMetadata[];
  replay?: AppServerThreadReplay;
  sendControlPrompt?: KimiSendControlPrompt;
  startPrompt?: KimiStartPrompt;
  overlayStore?: ReturnType<typeof createOverlayStoreMock>;
  codexClient?: MockBackendClient;
  ownerAdmission?: NonNullable<Parameters<typeof createDesktopBackendRegistry>[0]>["ownerAdmission"];
  codexEnvironmentCommandRunner?: CodexEnvironmentCommandRunner;
  gitDirectoryService?: unknown;
  gitWorkspaceHandoffService?: unknown;
  worktreeArchiveService?: WorktreeArchiveService;
  mcpConnectionService?: NonNullable<
    Parameters<typeof createDesktopBackendRegistry>[0]
  >["mcpConnectionService"];
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
  threadTitleGenerationService?: NonNullable<
    Parameters<typeof createDesktopBackendRegistry>[0]
  >["threadTitleGenerationService"];
  acpWorktreeRepositoryResolver?: (
    cwd: string,
  ) => Promise<LinkedDirectorySummary | undefined>;
  acpAvailableCommandsStore?: ReturnType<
    typeof createAcpAvailableCommandsStoreMock
  > | null;
  acpAvailableCommandProbeBudgetMs?: number;
  availableCommandsOnSessionStart?: AppServerAvailableCommandSummary[];
  createScratchProjectDirectory?: () => Promise<string>;
  startSession?: KimiStartSession;
  steerSession?: AcpSteerSession;
  supportsTurnSteering?: boolean;
  rewindSession?: AcpRewindSession;
  listRewindPoints?: AcpListRewindPoints;
  configureWorkflowBudget?: AcpConfigureWorkflowBudget;
  offersThoughtLevel?: (sessionId: string, level: string) => boolean;
  resolvePassSetupVariablesToAgents?: () => boolean;
  resolveCodexToolDiscovery?: () => boolean;
}) {
  const acpBackendId =
    options?.installedAgent?.backendId
    ?? options?.acpBackendId
    ?? ("acp:kimi" as AcpBackendId);
  const sessions = options?.sessions ?? [];
  const sessionId = options?.sessionId ?? "kimi-session-1";
  const sendControlPrompt: KimiSendControlPrompt =
    options?.sendControlPrompt ??
    vi.fn(async () => ({
      text: "You only live once! All actions will be auto-approved.",
    }));
  const startPrompt: KimiStartPrompt =
    options?.startPrompt ??
    vi.fn(() => ({ sessionId, turnId: "turn-1" }));
  const steerSession: AcpSteerSession =
    options?.steerSession
    ?? vi.fn(async () => ({ delivery: "currentTurn" as const }));
  const rewindSession: AcpRewindSession =
    options?.rewindSession
    ?? vi.fn(async () => ({ promptText: "Breakfast", updatedAt: 3000 }));
  const listRewindPoints: AcpListRewindPoints =
    options?.listRewindPoints
    ?? vi.fn(async () => []);
  const configureWorkflowBudget: AcpConfigureWorkflowBudget =
    options?.configureWorkflowBudget
    ?? vi.fn(async () => ({ defaultAgentBudget: 128, maxAgentBudget: 1024 }));
  const replay: AppServerThreadReplay =
    options?.replay ?? {
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle",
    };
  const acpClient = {
    controlPromptReceiverMarker: true,
    initialize: vi.fn(async () => undefined),
    dispose: vi.fn(),
    startSession: vi.fn(async (params: {
      acpRuntime?: BackendAcpSessionRuntimeState;
      cwd?: string;
      executionMode: "default" | "auto" | "full-access";
      hidden?: boolean;
      title?: string;
      titleSource?: AcpSessionMetadata["titleSource"];
      promptPlaceholderTitle?: true;
    }) => {
      if (options?.startSession) {
        return await options.startSession(params);
      }
      const resolvedSessionId = params.hidden
        ? `${sessionId}:title-helper:${sessions.length + 1}`
        : sessionId;
      const metadata: AcpSessionMetadata = {
        backendId: acpBackendId,
        sessionId: resolvedSessionId,
        title: params.title ?? "Untitled thread",
        titleSource: params.titleSource ?? (params.title ? "explicit" : "fallback"),
        ...(params.promptPlaceholderTitle ? { promptPlaceholderTitle: true as const } : {}),
        cwd: params.cwd,
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: params.executionMode,
        ...(params.acpRuntime ? { acpRuntime: params.acpRuntime } : {}),
        ...(params.hidden ? { hidden: true } : {}),
        // Agents advertise their commands over `session/update`, which can
        // land while `session/new` is still resolving.
        ...(options?.availableCommandsOnSessionStart
          ? { availableCommands: options.availableCommandsOnSessionStart }
          : {}),
        status: "idle",
      };
      sessions.push(metadata);
      return metadata;
    }),
    startPrompt,
    sendControlPrompt,
    ensureSession: vi.fn(async () => undefined),
    loadSession: vi.fn(async (): Promise<AppServerThreadReplay> => replay),
    refreshSession: vi.fn(async () => undefined),
    cancelSession: vi.fn(async (sessionId: string) => {
      answerAcpSessionCancel(registry, acpBackendId, sessionId);
    }),
    readReplay: vi.fn((): AppServerThreadReplay => replay),
    setRuntimeOption: vi.fn(async (params: {
      sessionId: string;
    }): Promise<BackendAcpSessionRuntimeState> =>
      sessions.find((session) => session.sessionId === params.sessionId)?.acpRuntime
      ?? { updatedAt: 1000 }),
    steerSession,
    supportsTurnSteering: () => options?.supportsTurnSteering === true,
    rewindSession,
    listRewindPoints,
    configureWorkflowBudget,
    ...(options?.offersThoughtLevel
      ? { offersThoughtLevel: options.offersThoughtLevel }
      : {}),
  };
  const registry = createDesktopBackendRegistry({ getThreadArchivePolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" }),
    ownerAdmission: options?.ownerAdmission,
    correspondenceStore: options?.correspondenceStore,
    codexClient: options?.codexClient ?? new MockBackendClient({ threads: [] }),
    overlayStore: options?.overlayStore ?? createOverlayStoreMock(),
    acpAgentStore: createAcpAgentStoreMock([
      options?.installedAgent
      ?? createKimiAgentRecord(acpBackendId, options?.runtimeCapabilities),
    ]),
    acpRolloutStore: options?.acpRolloutStore,
    acpSessionStore: createAcpSessionStoreMock(sessions),
    createAcpClient: () => acpClient,
    codexEnvironmentCommandRunner: options?.codexEnvironmentCommandRunner,
    gitDirectoryService: options?.gitDirectoryService as never,
    gitWorkspaceHandoffService:
      options?.gitWorkspaceHandoffService as never,
    worktreeArchiveService: options?.worktreeArchiveService,
    mcpConnectionService: options?.mcpConnectionService,
    acpWorktreeRepositoryResolver: options?.acpWorktreeRepositoryResolver,
    ...(options?.threadTitleGenerationService
      ? { threadTitleGenerationService: options.threadTitleGenerationService }
      : {}),
    acpAvailableCommandsStore: options?.acpAvailableCommandsStore,
    acpAvailableCommandProbeBudgetMs: options?.acpAvailableCommandProbeBudgetMs,
    createScratchProjectDirectory:
      options?.createScratchProjectDirectory
      ?? (async () => "/Users/test/.pwragent/projects/acp-scratch"),
    ...(options?.resolvePassSetupVariablesToAgents
      ? { resolvePassSetupVariablesToAgents: options.resolvePassSetupVariablesToAgents }
      : {}),
    ...(options?.resolveCodexToolDiscovery
      ? { resolveCodexToolDiscovery: options.resolveCodexToolDiscovery }
      : {}),
  });
  return {
    acpBackendId,
    acpClient,
    registry,
    sendControlPrompt,
    sessions,
    startPrompt,
    steerSession,
    rewindSession,
    configureWorkflowBudget,
  };
}

/**
 * Match how the registry keys the ACP command cache: an absolute, forward-
 * slashed path. `path.resolve` differs per platform, so tests must not hardcode
 * the POSIX form of a repo root.
 */
export function toTestRepositoryPath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

export function createAcpAvailableCommandsStoreMock(
  records: AcpAvailableCommandsRecord[] = [],
) {
  return {
    records,
    get: vi.fn((backendId: string, repositoryPath: string) =>
      records.find(
        (record) =>
          record.backendId === backendId
          && record.repositoryPath === repositoryPath,
      ),
    ),
    upsert: vi.fn((record: AcpAvailableCommandsRecord) => {
      const index = records.findIndex(
        (candidate) =>
          candidate.backendId === record.backendId
          && candidate.repositoryPath === record.repositoryPath,
      );
      if (index === -1) {
        records.push(record);
      } else {
        records[index] = record;
      }
    }),
  };
}

export async function callRegistryMcpTool(params: {
  registry: DesktopBackendRegistry;
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
  tool: string;
  callId?: string;
  args: Record<string, unknown>;
}) {
  const internal = params.registry as unknown as {
    threadOrchestrationHandler: (
      request: PwrAgentThreadOrchestrationRequest,
    ) => Promise<PwrAgentThreadOrchestrationResponse>;
  };
  const catalogs = resolveAgentToolCatalogs({
    taskMonitorHandler: async (request) =>
      await registryModules(params.registry).subAgentMonitorService.handleAgentTaskMonitorRequest(request),
    threadOrchestrationHandler: internal.threadOrchestrationHandler,
  }, { taskMonitorRole: "all" });
  const router = catalogs
    .map((catalog) => catalog.router)
    .find((candidate) =>
      candidate.acceptsMcpToolCall({ tool: params.tool }),
    );
  if (!router) {
    throw new Error(`MCP tool was not advertised: ${params.tool}`);
  }
  return await router.handleMcpToolCall({
    backend: params.backend,
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.callId ?? `mcp:${params.tool}`,
    tool: params.tool,
    args: params.args,
  });
}

/**
 * Answer session/cancel the way an ACP agent does: the agent settles the
 * session's running prompt with stopReason cancelled, which the adapter
 * reports as turn/cancelled after the cancel notification has gone out.
 * Without that answer, close() waits out the whole shutdown-stop deadline
 * for each turn a test leaves running.
 */
export function answerAcpSessionCancel(
  registry: DesktopBackendRegistry,
  backend: AcpBackendId,
  sessionId: string,
): void {
  const internal = registry as unknown as {
    emit(event: AgentEvent): Promise<void>;
  };
  const prefix = `${backend}:${sessionId}:`;
  const turnIds = [...registryModules(registry).turnState.registeredTurnKeys()].flatMap((key) => {
    const turnId = key.slice(prefix.length);
    // Any other suffix belongs to a longer session id, such as a helper's.
    return key.startsWith(prefix)
      && (!turnId.includes(":") || turnId.startsWith("pending:"))
      ? [turnId]
      : [];
  });
  void Promise.resolve().then(async () => {
    for (const turnId of turnIds) {
      await internal.emit({
        backend,
        notification: {
          method: "turn/cancelled",
          params: {
            threadId: sessionId,
            turnId,
            turn: { id: turnId, status: "cancelled", completedAt: Date.now() },
          },
        },
      });
    }
  });
}

export async function emitCompletedTurn(
  registry: DesktopBackendRegistry,
  backend: AppServerBackendKind,
  threadId: string,
  turnId = "turn-1",
): Promise<void> {
  await (
    registry as unknown as { emit(event: AgentEvent): Promise<void> }
  ).emit({
    backend,
    notification: {
      method: "turn/completed",
      params: {
        threadId,
        turnId,
        turn: {
          id: turnId,
          status: "completed",
          output: [],
        },
      },
    },
  });
}

export async function emitStartedTurn(
  registry: DesktopBackendRegistry,
  backend: AppServerBackendKind,
  threadId: string,
  turnId: string,
): Promise<void> {
  await (
    registry as unknown as { emit(event: AgentEvent): Promise<void> }
  ).emit({
    backend,
    notification: {
      method: "turn/started",
      params: {
        threadId,
        turnId,
        turn: {
          id: turnId,
          status: "in_progress",
          startedAt: Date.now(),
        },
      },
    },
  });
}

export async function discoverCodexBackendForTest(
  registry: DesktopBackendRegistry,
): Promise<void> {
  await registry.listBackends(
    { includeUnavailable: true, refreshModels: "codex" },
    issueProviderDiscoveryPermit("settings-user-action"),
  );
}

export function rememberCollapsedDirectoryWithPinnedThread(params: {
  directoryKey: string;
  directoryPath: string;
  registry: DesktopBackendRegistry;
  threadId?: string;
  collapsed?: boolean;
  unpinnedThreadIds?: string[];
}): void {
  const threadId = params.threadId ?? "thread-pinned";
  params.registry.rememberCompleteNavigationSnapshot(buildNavigationSnapshot({
    backend: "all",
    fetchedAt: 1_000,
    firstSnapshot: false,
    directoryOverlayByKey: {
      [params.directoryKey]: {
        directoryKey: params.directoryKey,
        directoryThreadsCollapsed: params.collapsed ?? true,
      },
    },
    overlayByThreadKey: {
      [`codex:${threadId}`]: {
        backend: "codex",
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
        pinnedRank: "1024",
      },
    },
    previousKnownThreadKeys: [`codex:${threadId}`],
    threads: [threadId, ...(params.unpinnedThreadIds ?? [])].map((id) => ({
      id,
      title: id === threadId ? "Pinned thread" : id,
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: params.directoryKey,
          kind: "local",
          label: "project",
          path: params.directoryPath,
        },
      ],
      updatedAt: 1_000,
    })),
    unchanged: false,
  }));
}

// close() asks each running turn to stop and waits up to 2s for its terminal.
// A fake that accepts the stop and never ends the turn costs every test that
// leaves one running the whole deadline, which is how this file once grew
// from 10s to 106s on CI. Answer the stop the way the backend does
// (`answerAcpSessionCancel`, `interruptEndsTurn`).
let restoreGitEnvironment: () => void;
beforeEach(() => {
  installOwnerHostServices({
    ...getOwnerHostServices(),
    notifications: desktopNotificationServiceMock.getDesktopNotificationService(),
  });
  // Branch proofs read process.env, while setup Git uses gitTestEnv. Keep
  // both inside the fixture: inherited config/location overrides correctly
  // defer a production probe to owned Git, but are not part of these repos.
  restoreGitEnvironment = isolateProcessGitEnvironment();
  mainLoggerMock.warn.mockClear();
});
afterEach(() => {
  restoreGitEnvironment();
  expect(
    mainLoggerMock.warn.mock.calls.filter(([message]) =>
      message === "running turns still unanswered at the shutdown deadline"
    ),
  ).toEqual([]);
});

export { mainLoggerMock, localAcpDiscoveryMock, desktopNotificationServiceMock, requestShowThreadMock, configuredMemberRole };
