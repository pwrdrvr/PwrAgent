import type {
  AppServerBackendScope,
  AppServerThreadSummary,
  DirectoryLaunchpadOverlayState,
  LinkedDirectorySummary,
  MarkThreadSeenResponse,
  MessagingThreadBindingSummary,
  NavigationDirectoryGitStatus,
  NavigationLaunchpadDefaults,
  NavigationSnapshot,
  PrSummary,
  ThreadExecutionMode,
  ThreadOverlayState,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import {
  buildNavigationSnapshot,
  buildNavigationSnapshotHash,
} from "@pwragent/agent-core";
import type { StateDb } from "./state-db.js";

export class SqliteOverlayStore {
  constructor(private readonly stateDb: StateDb) {}

  async reconcileNavigationSnapshot(params: {
    backend: AppServerBackendScope;
    fetchedAt: number;
    gitStatusByDirectoryKey?: Record<string, NavigationDirectoryGitStatus | undefined>;
    /**
     * Active messaging bindings per thread, keyed by thread identity key.
     * Sourced from the desktop messaging sqlite store. Optional so tests
     * (and any future callers without messaging) can keep working.
     */
    messagingBindingsByThreadKey?: Record<
      string,
      MessagingThreadBindingSummary[] | undefined
    >;
    threads: AppServerThreadSummary[];
  }): Promise<NavigationSnapshot> {
    const backendState = this.getBackend(params.backend);
    const firstSnapshot = !backendState?.lastSnapshotHash;

    if (firstSnapshot) {
      for (const thread of params.threads) {
        const threadKey = buildThreadIdentityKey(thread.source, thread.id);
        const current = this.getThread(threadKey);
        this.putThread(threadKey, {
          backend: thread.source,
          threadId: thread.id,
          executionMode: current?.executionMode ?? thread.executionMode ?? "default",
          model: current?.model ?? thread.model,
          reasoningEffort: current?.reasoningEffort ?? thread.reasoningEffort,
          serviceTier: current?.serviceTier ?? thread.serviceTier,
          fastMode: current?.fastMode ?? thread.fastMode,
          gitBranch: current?.gitBranch,
          observedGitBranch: current?.observedGitBranch,
          retainedBranchDriftPairs: current?.retainedBranchDriftPairs,
          lastSeenAt: params.fetchedAt,
          lastSeenUpdatedAt: thread.updatedAt,
          extraLinkedDirectories: current?.extraLinkedDirectories ?? [],
          worktreeSnapshots: current?.worktreeSnapshots ?? [],
        });
      }
    }

    const overlayByThreadKey = Object.fromEntries(
      params.threads.map((thread) => {
        const threadKey = buildThreadIdentityKey(thread.source, thread.id);
        return [threadKey, this.getThread(threadKey)];
      }),
    );

    const launchpadDefaults = this.readLaunchpadDefaults();
    const launchpadsByKey = this.readAllDirectoryLaunchpads();

    const snapshot = buildNavigationSnapshot({
      backend: params.backend,
      fetchedAt: params.fetchedAt,
      firstSnapshot,
      gitStatusByDirectoryKey: params.gitStatusByDirectoryKey,
      launchpadDefaults,
      launchpadsByKey,
      messagingBindingsByThreadKey: params.messagingBindingsByThreadKey,
      overlayByThreadKey,
      previousKnownThreadKeys: backendState?.knownThreadKeys ?? [],
      threads: params.threads,
      unchanged: false,
    });

    const nextHash = buildNavigationSnapshotHash({
      backend: params.backend,
      directories: snapshot.directories,
      launchpadDefaults: snapshot.launchpadDefaults,
      threads: snapshot.threads,
    });
    const unchanged = backendState?.lastSnapshotHash === nextHash;

    this.putBackend(params.backend, {
      knownThreadKeys: params.threads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
      lastSnapshotHash: nextHash,
    });

    return { ...snapshot, unchanged };
  }

  async markThreadSeen(params: {
    backend: ThreadOverlayState["backend"];
    seenAt?: number;
    seenUpdatedAt?: number;
    threadId: string;
  }): Promise<MarkThreadSeenResponse> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey);
    const seenAt = params.seenAt ?? Date.now();

    this.putThread(threadKey, {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: current?.executionMode ?? "default",
      model: current?.model,
      reasoningEffort: current?.reasoningEffort,
      serviceTier: current?.serviceTier,
      fastMode: current?.fastMode,
      gitBranch: current?.gitBranch,
      observedGitBranch: current?.observedGitBranch,
      dismissedAt: current?.dismissedAt,
      snoozedUntil: current?.snoozedUntil,
      retainedBranchDriftPairs: current?.retainedBranchDriftPairs,
      lastSeenAt: seenAt,
      lastSeenUpdatedAt: params.seenUpdatedAt ?? current?.lastSeenUpdatedAt,
      extraLinkedDirectories: current?.extraLinkedDirectories ?? [],
      worktreeSnapshots: current?.worktreeSnapshots ?? [],
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      seenAt,
      seenUpdatedAt: params.seenUpdatedAt,
    };
  }

  async addLinkedDirectory(params: {
    backend: ThreadOverlayState["backend"];
    directory: LinkedDirectorySummary;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      extraLinkedDirectories: [
        ...current.extraLinkedDirectories.filter(
          (d) => d.id !== params.directory.id,
        ),
        params.directory,
      ],
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async replaceWorkspaceLinkedDirectory(params: {
    backend: ThreadOverlayState["backend"];
    directory: LinkedDirectorySummary;
    gitBranch?: string;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextDirectories = [
      ...current.extraLinkedDirectories.filter((directory) => {
        if (directory.id === params.directory.id) return false;
        if (isHandoffDirectory(directory)) return false;
        return directory.path !== params.directory.path;
      }),
      params.directory,
    ];
    const nextState: ThreadOverlayState = {
      ...current,
      gitBranch: params.gitBranch ?? current.gitBranch,
      observedGitBranch: params.gitBranch ?? current.observedGitBranch,
      extraLinkedDirectories: nextDirectories,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async getThreadExecutionMode(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<ThreadExecutionMode> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    return this.getThread(threadKey)?.executionMode ?? "default";
  }

  async getThreadOverlayState(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<ThreadOverlayState | undefined> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    return this.getThread(threadKey);
  }

  async setThreadReaction(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    emoji: string;
    present: boolean;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const existing = current.reactions ?? [];
    const filtered = existing.filter((emoji) => emoji !== params.emoji);
    const nextReactions = params.present ? [...filtered, params.emoji] : filtered;
    const nextState: ThreadOverlayState = {
      ...current,
      reactions: nextReactions,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadPullRequests(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    prs: PrSummary[];
    fetchedAt?: number;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      prs: params.prs,
      prsFetchedAt: params.fetchedAt ?? Date.now(),
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async getThreadOverlayStates(params: {
    backend: ThreadOverlayState["backend"];
    threadIds: string[];
  }): Promise<Record<string, ThreadOverlayState | undefined>> {
    return Object.fromEntries(
      params.threadIds.map((threadId) => {
        const threadKey = buildThreadIdentityKey(params.backend, threadId);
        return [threadId, this.getThread(threadKey)];
      }),
    );
  }

  async upsertWorktreeSnapshot(params: {
    backend: ThreadOverlayState["backend"];
    snapshot: WorktreeSnapshotSummary;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextSnapshots = [
      ...(current.worktreeSnapshots ?? []).filter(
        (s) => s.id !== params.snapshot.id,
      ),
      params.snapshot,
    ].sort((a, b) => a.worktreePath.localeCompare(b.worktreePath));
    const nextState: ThreadOverlayState = {
      ...current,
      worktreeSnapshots: nextSnapshots,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadExecutionMode(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    executionMode: ThreadExecutionMode;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = { ...current, executionMode: params.executionMode };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadModelSettings(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    fastMode?: boolean;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      serviceTier: params.serviceTier,
      fastMode: params.fastMode,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadExpectedBranch(params: {
    backend: ThreadOverlayState["backend"];
    branch: string;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      gitBranch: params.branch,
      observedGitBranch: params.branch,
      retainedBranchDriftPairs: (current.retainedBranchDriftPairs ?? []).filter(
        (pair) =>
          pair.expectedBranch !== params.branch &&
          pair.observedBranch !== params.branch,
      ),
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadObservedBranch(params: {
    backend: ThreadOverlayState["backend"];
    branch?: string;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const previousObservedBranch = current.observedGitBranch?.trim();
    const nextObservedBranch = params.branch?.trim();
    const legacyHandoffExpectedBranch =
      !current.gitBranch?.trim() &&
      previousObservedBranch &&
      nextObservedBranch &&
      previousObservedBranch !== nextObservedBranch &&
      hasHandoffWorkspace(current.extraLinkedDirectories)
        ? previousObservedBranch
        : undefined;
    const nextState: ThreadOverlayState = {
      ...current,
      gitBranch: current.gitBranch?.trim()
        ? current.gitBranch
        : legacyHandoffExpectedBranch,
      observedGitBranch: params.branch,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async retainThreadBranchDrift(params: {
    backend: ThreadOverlayState["backend"];
    expectedBranch: string;
    observedBranch: string;
    retainedAt?: number;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const retainedBranchDriftPairs = [
      ...(current.retainedBranchDriftPairs ?? []).filter(
        (pair) =>
          pair.expectedBranch !== params.expectedBranch ||
          pair.observedBranch !== params.observedBranch,
      ),
      {
        expectedBranch: params.expectedBranch,
        observedBranch: params.observedBranch,
        retainedAt: params.retainedAt ?? Date.now(),
      },
    ];
    const nextState: ThreadOverlayState = { ...current, retainedBranchDriftPairs };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async getLaunchpadDefaults(): Promise<NavigationLaunchpadDefaults> {
    return this.readLaunchpadDefaults();
  }

  async setLaunchpadDefaults(
    patch: Partial<NavigationLaunchpadDefaults>,
  ): Promise<NavigationLaunchpadDefaults> {
    const current = this.readLaunchpadDefaults();
    const next = { ...current, ...patch };
    this.writeLaunchpadDefaults(next);
    return next;
  }

  async getDirectoryLaunchpad(params: {
    directoryKey: string;
  }): Promise<DirectoryLaunchpadOverlayState | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM directory_launchpads WHERE directory_path = ?")
      .get(params.directoryKey) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async listDirectoryLaunchpads(): Promise<DirectoryLaunchpadOverlayState[]> {
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM directory_launchpads")
      .all() as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload));
  }

  async upsertDirectoryLaunchpad(
    launchpad: DirectoryLaunchpadOverlayState,
  ): Promise<DirectoryLaunchpadOverlayState> {
    const current = await this.getDirectoryLaunchpad({
      directoryKey: launchpad.directoryKey,
    });
    const next: DirectoryLaunchpadOverlayState = {
      ...current,
      ...launchpad,
      createdAt: current?.createdAt ?? launchpad.createdAt,
    };
    const now = Date.now();
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO directory_launchpads(directory_path, payload, created_at, updated_at, settings_touched_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        next.directoryKey,
        JSON.stringify(next),
        next.createdAt ?? now,
        next.updatedAt ?? now,
        next.settingsTouchedAt ?? null,
      );
    return next;
  }

  async resetDirectoryLaunchpad(params: { directoryKey: string }): Promise<void> {
    this.stateDb.raw
      .prepare("DELETE FROM directory_launchpads WHERE directory_path = ?")
      .run(params.directoryKey);
  }

  private getThread(threadKey: string): ThreadOverlayState | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM threads WHERE thread_id = ?")
      .get(threadKey) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  private putThread(threadKey: string, state: ThreadOverlayState): void {
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadKey,
        (state as Record<string, unknown>).directoryPath as string ?? null,
        state.lastSeenAt ?? null,
        state.dismissedAt ?? null,
        state.snoozedUntil ?? null,
        JSON.stringify(state),
      );
  }

  private getBackend(
    scope: string,
  ): { knownThreadKeys: string[]; lastSnapshotHash?: string } | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM backends WHERE scope = ?")
      .get(scope) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  private putBackend(
    scope: string,
    state: { knownThreadKeys: string[]; lastSnapshotHash?: string },
  ): void {
    this.stateDb.raw
      .prepare("INSERT OR REPLACE INTO backends(scope, payload) VALUES (?, ?)")
      .run(scope, JSON.stringify(state));
  }

  private readLaunchpadDefaults(): NavigationLaunchpadDefaults {
    const defaults: Record<string, unknown> = {};
    const rows = this.stateDb.raw
      .prepare("SELECT key, value FROM launchpad_defaults")
      .all() as { key: string; value: string }[];
    for (const row of rows) {
      defaults[row.key] = JSON.parse(row.value);
    }
    return (
      Object.keys(defaults).length > 0
        ? defaults
        : { backend: "codex", executionMode: "default" }
    ) as NavigationLaunchpadDefaults;
  }

  private writeLaunchpadDefaults(defaults: NavigationLaunchpadDefaults): void {
    const stmt = this.stateDb.raw.prepare(
      "INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)",
    );
    const write = this.stateDb.raw.transaction(() => {
      for (const [key, value] of Object.entries(defaults)) {
        if (value !== undefined) {
          stmt.run(key, JSON.stringify(value));
        }
      }
    });
    write();
  }

  private readAllDirectoryLaunchpads(): Record<string, DirectoryLaunchpadOverlayState> {
    const rows = this.stateDb.raw
      .prepare("SELECT directory_path, payload FROM directory_launchpads")
      .all() as { directory_path: string; payload: string }[];
    return Object.fromEntries(
      rows.map((r) => [r.directory_path, JSON.parse(r.payload)]),
    );
  }
}

/** Check whether a linked directory was created by the handoff service. */
function isHandoffDirectory(directory: LinkedDirectorySummary): boolean {
  return (
    directory.id.startsWith("pwragent-handoff:") ||
    directory.id.startsWith("pwragnt-handoff:")  // legacy prefix from pre-rebrand data
  );
}

function hasHandoffWorkspace(
  directories: ThreadOverlayState["extraLinkedDirectories"] = [],
): boolean {
  return directories.some(isHandoffDirectory);
}

export type OverlayStoreLike = Pick<
  SqliteOverlayStore,
  | "reconcileNavigationSnapshot"
  | "markThreadSeen"
  | "addLinkedDirectory"
  | "replaceWorkspaceLinkedDirectory"
  | "getThreadExecutionMode"
  | "getThreadOverlayState"
  | "getThreadOverlayStates"
  | "setThreadReaction"
  | "setThreadPullRequests"
  | "upsertWorktreeSnapshot"
  | "setThreadExecutionMode"
  | "setThreadModelSettings"
  | "setThreadExpectedBranch"
  | "setThreadObservedBranch"
  | "retainThreadBranchDrift"
  | "getLaunchpadDefaults"
  | "setLaunchpadDefaults"
  | "getDirectoryLaunchpad"
  | "listDirectoryLaunchpads"
  | "upsertDirectoryLaunchpad"
  | "resetDirectoryLaunchpad"
>;
