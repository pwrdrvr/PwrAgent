import { app, BrowserWindow } from "electron";
import {
  buildThreadIdentityKey,
  parseThreadIdentityKey,
  type AppServerBackendKind,
  type AppServerThreadTitleSource,
  type FederationRemoteTarget,
  type NavigationThreadSummary,
  type RemoteThreadPin,
} from "@pwragent/shared";
import { getDesktopBackendRegistry } from "./app-server/backend-registry";
import {
  listRunningDetachedCommands,
  type DetachedCommandSummary,
} from "./app-server/codex-environment-runtime";
import { getDesktopOverlayStore } from "./app-server/desktop-overlay-store";
import { getDesktopAutomationService } from "./automations/desktop-automation-service";
import { getDesktopFederationRuntime } from "./federation/federation-runtime";
import { getIntegratedTerminalQuitSnapshot } from "./ipc/integrated-terminal";
import { getMainLogger } from "./log";
import {
  byThreadKey,
  type IntegratedTerminalQuitThread,
} from "./terminal/integrated-terminal-service";
import { getDesktopSettingsService } from "./settings/desktop-settings-singleton";
import {
  focusActiveQuitConfirmationDialog,
  showQuitConfirmationDialog,
  type QuitConfirmationDialogResult,
  type QuitConfirmationDialogSnapshot,
} from "./quit-confirmation-dialog";
import type {
  QuitBlockerItem,
  QuitBlockerQueueSnapshot,
} from "../shared/quit-blockers";

export type { QuitBlockerItem };

export const QUIT_CONFIRMATION_COUNTDOWN_SECONDS = 10;

export type QuitRequestSource =
  | "before-quit"
  | "ipc"
  | "agent-tool"
  | "main-window-closed"
  | "menu"
  | "signal"
  | "update-install"
  | "window-all-closed";

export type RequestQuitOptions = {
  performQuit?: () => void;
  source: QuitRequestSource;
};

export type QuitBlockerSnapshot = {
  count: number;
  terminalSessionCount: number;
  terminalThreadKeys: string[];
  threadIds: string[];
  actionRunCount: number;
  automationRunCount?: number;
  items: QuitBlockerItem[];
};

export type QuitManagerDependencies = {
  confirm?: (params: {
    countdownSeconds: number;
    inProgressThreadCount: number;
    terminalSessionCount: number;
    actionRunCount?: number;
    items?: QuitBlockerItem[];
    parent?: BrowserWindow | null;
    refresh?: () => Promise<QuitConfirmationDialogSnapshot>;
  }) => Promise<QuitConfirmationDialogResult>;
  /**
   * Raise the confirmation prompt that is already open. Returns false when
   * there is nothing to raise. See the `promptPromise` branch in `requestQuit`.
   */
  focusPendingConfirmation?: () => boolean;
  getConfirmationEnabled: () => boolean;
  getFocusedWindow?: () => BrowserWindow | null;
  getQuitBlockers: () => QuitBlockerSnapshot;
  /** Hold new automation launches until quitting proceeds or the prompt closes. */
  quiesceAutomationDispatch?: () => () => Promise<void> | void;
  /**
   * Best-effort thread-title lookup for the dialog's links, keyed by
   * `quitBlockerTitleKey`. Takes whole items rather than thread keys because
   * naming a row requires knowing which instance owns it.
   */
  resolveThreadTitles?: (
    items: QuitBlockerItem[],
  ) => Promise<Map<string, string>>;
  log: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
  performQuit: () => void;
};

/** Titles are a nicety; quitting must not hang on optional cache/store reads. */
const QUIT_TITLE_RESOLVE_TIMEOUT_MS = 1_500;

export type QuitManager = {
  allowImmediateQuit: () => void;
  isQuitAllowed: () => boolean;
  requestQuit: (options: RequestQuitOptions) => Promise<boolean>;
};

export function createQuitManager(
  dependencies: QuitManagerDependencies,
): QuitManager {
  let quitAllowed = false;
  let pendingPerformQuit: (() => void) | undefined;
  let promptPromise: Promise<boolean> | undefined;
  let activePromptId = 0;
  let nextPromptId = 0;

  const resumeAutomationDispatchAfterPrompt = (
    resumeAutomationDispatch: (() => Promise<void> | void) | undefined,
  ): void => {
    if (!resumeAutomationDispatch) return;
    void Promise.resolve()
      .then(() => resumeAutomationDispatch())
      .catch((error: unknown) => {
        dependencies.log.warn?.("automation dispatch resume failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const requestQuit = async (options: RequestQuitOptions): Promise<boolean> => {
    if (quitAllowed) {
      (options.performQuit ?? dependencies.performQuit)();
      return true;
    }

    const snapshot = dependencies.getQuitBlockers();
    if (snapshot.count <= 0) {
      dependencies.log.info?.("quit requested with no active work", {
        source: options.source,
      });
      quitAllowed = true;
      (options.performQuit ?? dependencies.performQuit)();
      return true;
    }

    if (!dependencies.getConfirmationEnabled()) {
      dependencies.log.warn?.(
        "quit requested with active work; confirmation disabled",
        {
          count: snapshot.count,
          actionRunCount: snapshot.actionRunCount,
          automationRunCount: snapshot.automationRunCount ?? 0,
          source: options.source,
          terminalSessionCount: snapshot.terminalSessionCount,
          terminalThreadKeys: snapshot.terminalThreadKeys,
          threadIds: snapshot.threadIds,
        },
      );
      quitAllowed = true;
      (options.performQuit ?? dependencies.performQuit)();
      return true;
    }

    if (promptPromise) {
      if (options.performQuit) {
        pendingPerformQuit = options.performQuit;
      }
      // Asking again has to do *something*. Any deliberate interaction with the
      // prompt — a click, a scroll, a keystroke — cancels its countdown for
      // good and clears the main-process ceiling with it, so from that point the
      // only thing that ever settles this quit is the user answering the dialog.
      // It is a small frameless window that can end up behind the main window or
      // on another Space, and a repeat request that silently returns this
      // pending promise reads as an app that refuses to quit. Raise it instead.
      const raised = dependencies.focusPendingConfirmation?.() ?? false;
      dependencies.log.info?.("quit requested while confirmation is open", {
        raisedConfirmation: raised,
        source: options.source,
      });
      return await promptPromise;
    }

    dependencies.log.warn?.("quit requested with active work", {
      count: snapshot.count,
      actionRunCount: snapshot.actionRunCount,
      automationRunCount: snapshot.automationRunCount ?? 0,
      source: options.source,
      terminalSessionCount: snapshot.terminalSessionCount,
      terminalThreadKeys: snapshot.terminalThreadKeys,
      threadIds: snapshot.threadIds,
    });

    pendingPerformQuit = options.performQuit ?? dependencies.performQuit;
    const promptId = nextPromptId + 1;
    nextPromptId = promptId;
    activePromptId = promptId;
    const clearPrompt = (): void => {
      if (activePromptId !== promptId) return;
      activePromptId = 0;
      promptPromise = undefined;
    };
    const currentPrompt = (async () => {
      const resumeAutomationDispatch = dependencies.quiesceAutomationDispatch?.();
      // Skip the round trip entirely when there is nothing to title, so the
      // no-resolver path reaches `confirm` without an extra microtask hop.
      const items =
        dependencies.resolveThreadTitles && snapshot.items.length > 0
          ? await withResolvedTitles(
              snapshot.items,
              dependencies.resolveThreadTitles,
              dependencies.log,
            )
          : snapshot.items;
      let resolution: QuitConfirmationDialogResult;
      try {
        resolution = await (dependencies.confirm ?? showQuitConfirmationDialog)({
          countdownSeconds: QUIT_CONFIRMATION_COUNTDOWN_SECONDS,
          inProgressThreadCount: snapshot.threadIds.length,
          automationRunCount: snapshot.automationRunCount ?? 0,
          terminalSessionCount: snapshot.terminalSessionCount,
          actionRunCount: snapshot.actionRunCount,
          items,
          parent: dependencies.getFocusedWindow?.(),
          refresh: async () =>
            await buildQuitConfirmationSnapshot(
              dependencies.getQuitBlockers(),
              dependencies.resolveThreadTitles,
              dependencies.log,
            ),
        });
      } catch (error) {
        clearPrompt();
        resumeAutomationDispatchAfterPrompt(resumeAutomationDispatch);
        throw error;
      }
      dependencies.log.warn?.("quit confirmation resolved", {
        count: snapshot.count,
        actionRunCount: snapshot.actionRunCount,
        automationRunCount: snapshot.automationRunCount ?? 0,
        resolution,
        source: options.source,
        terminalSessionCount: snapshot.terminalSessionCount,
        terminalThreadKeys: snapshot.terminalThreadKeys,
        threadIds: snapshot.threadIds,
      });
      if (resolution === "manual-cancel") {
        pendingPerformQuit = undefined;
        // The dialog is already gone. Release this prompt before gates and
        // backend submissions resume so a new quit request can open a visible
        // confirmation instead of joining work nobody can see.
        clearPrompt();
        resumeAutomationDispatchAfterPrompt(resumeAutomationDispatch);
        return false;
      }
      quitAllowed = true;
      (pendingPerformQuit ?? dependencies.performQuit)();
      pendingPerformQuit = undefined;
      return true;
    })();
    promptPromise = currentPrompt;

    try {
      return await currentPrompt;
    } finally {
      clearPrompt();
    }
  };

  return {
    allowImmediateQuit: () => {
      quitAllowed = true;
    },
    isQuitAllowed: () => quitAllowed,
    requestQuit,
  };
}

export async function buildQuitConfirmationSnapshot(
  snapshot: QuitBlockerSnapshot,
  resolveThreadTitles: QuitManagerDependencies["resolveThreadTitles"],
  log: QuitManagerDependencies["log"],
): Promise<QuitConfirmationDialogSnapshot> {
  const items =
    resolveThreadTitles && snapshot.items.some((item) => !item.title)
      ? await withResolvedTitles(snapshot.items, resolveThreadTitles, log)
      : snapshot.items;
  return {
    inProgressThreadCount: snapshot.threadIds.length,
    automationRunCount: snapshot.automationRunCount ?? 0,
    terminalSessionCount: snapshot.terminalSessionCount,
    actionRunCount: snapshot.actionRunCount,
    items,
  };
}

export function buildQuitBlockerSnapshot(params: {
  inProgressThreads: {
    count: number;
    threadIds: string[];
    subAgentThreadKeys?: string[];
    threadTitles?: Record<string, string>;
    automationRuns?: Array<{
      agentThreadId: string;
      automationName?: string;
      automationRunId: string;
      backend: AppServerBackendKind;
      startedAt: number;
    }>;
  };
  terminalSessions: {
    count: number;
    threads: IntegratedTerminalQuitThread[];
  };
  actionRuns?: DetachedCommandSummary[];
}): QuitBlockerSnapshot {
  const threadIds = [...params.inProgressThreads.threadIds].sort();
  const terminalThreads = [...params.terminalSessions.threads].sort(byThreadKey);
  const terminalThreadKeys = terminalThreads.map((thread) => thread.threadKey);
  const actionRuns = params.actionRuns ?? [];
  const automationRuns = params.inProgressThreads.automationRuns ?? [];
  const subAgentThreadKeys = new Set(
    params.inProgressThreads.subAgentThreadKeys ?? [],
  );
  const threadTitles = params.inProgressThreads.threadTitles ?? {};

  const items: QuitBlockerItem[] = [
    // Turns and actions are driven by THIS instance's registry and runtime,
    // so they are always local. Only terminals can be a peer's.
    ...threadIds.map((threadKey) => ({
      kind: "turn" as const,
      ...splitQuitThreadKey(threadKey),
      threadKey,
      ...(threadTitles[threadKey] ? { title: threadTitles[threadKey] } : {}),
      ...(subAgentThreadKeys.has(threadKey) ? { isSubAgent: true } : {}),
    })),
    ...automationRuns.map((run) => ({
      kind: "automation" as const,
      backend: run.backend,
      threadId: run.agentThreadId,
      threadKey: buildThreadIdentityKey(run.backend, run.agentThreadId),
      title: run.automationName?.trim() || "Automation",
      detail: formatAutomationRunStart(run.startedAt),
      startedAt: run.startedAt,
    })),
    ...terminalThreads.map((thread) => ({
      kind: "terminal" as const,
      ...splitQuitThreadKey(thread.threadKey),
      threadKey: thread.threadKey,
      ...(thread.target ? { target: thread.target } : {}),
      // The peer's name is what separates this row from a local shell; the
      // title alone reads as though the work is on this machine.
      ...(thread.instanceLabel ? { detail: thread.instanceLabel } : {}),
    })),
    ...actionRuns.map((run) => ({
      kind: "action" as const,
      backend: run.backend,
      threadId: run.threadId,
      threadKey: buildThreadIdentityKey(
        run.backend as AppServerBackendKind,
        run.threadId,
      ),
      // Name the action up front. A thread title (resolved later) is nicer, but
      // an auto-started action can briefly outrun its own thread's creation, and
      // a row labelled with an empty thread id is worse than useless.
      title: run.actionName,
      detail: run.pid ? `${run.command} · pid ${run.pid}` : run.command,
    })),
  ];

  return {
    count:
      threadIds.length
      + automationRuns.length
      + params.terminalSessions.count
      + actionRuns.length,
    terminalSessionCount: params.terminalSessions.count,
    terminalThreadKeys,
    threadIds,
    actionRunCount: actionRuns.length,
    automationRunCount: automationRuns.length,
    items,
  };
}

export function formatAutomationRunStart(startedAt: number): string {
  return `Started ${new Date(startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

/**
 * Attach thread titles to the blocker rows, bounded by a timeout: a hung
 * optional title source must not be able to wedge shutdown. On timeout or
 * failure the rows keep their thread ids, which still link correctly — they
 * just read worse.
 */
async function withResolvedTitles(
  items: QuitBlockerItem[],
  resolve: QuitManagerDependencies["resolveThreadTitles"],
  log: QuitManagerDependencies["log"],
): Promise<QuitBlockerItem[]> {
  if (!resolve || items.length === 0) {
    return items;
  }
  const unresolvedItems = items.filter((item) => !item.title?.trim());
  if (unresolvedItems.length === 0) {
    return items;
  }
  const byTitleKey = new Map(
    unresolvedItems.map((item) => [quitBlockerTitleKey(item), item]),
  );
  let titles: Map<string, string>;
  try {
    titles = await Promise.race([
      resolve([...byTitleKey.values()]),
      new Promise<Map<string, string>>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("thread-title resolution timed out")),
          QUIT_TITLE_RESOLVE_TIMEOUT_MS,
        ).unref?.();
      }),
    ]);
  } catch (error) {
    log.warn?.("quit blocker title resolution failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return items;
  }
  return items.map((item) => {
    const title = titles.get(quitBlockerTitleKey(item));
    return title ? { ...item, title } : item;
  });
}

/**
 * Identity of the thread a row points at. A thread key alone is not it: two
 * instances can hold the same `backend:threadId`, and a remote row must never
 * inherit a same-keyed local thread's name.
 */
export function quitBlockerTitleKey(
  item: Pick<QuitBlockerItem, "threadKey" | "target">,
): string {
  return item.target
    ? `${item.target.instanceId}::${item.threadKey}`
    : item.threadKey;
}

type QuitBlockerThreadTitle = {
  title?: string;
  titleSource?: AppServerThreadTitleSource;
};

export type QuitBlockerTitleResolverDependencies = {
  /** Already-observed display metadata for a thread owned by THIS instance. */
  cachedLocalThreadName: (params: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => QuitBlockerThreadTitle | undefined;
  /**
   * What a peer calls one of its threads, out of names ALREADY seen locally.
   * Synchronous by contract: this must not become a peer round trip.
   */
  cachedRemoteThreadName: (params: {
    target: FederationRemoteTarget;
    backend: AppServerBackendKind;
    threadId: string;
  }) => QuitBlockerThreadTitle | undefined;
  /** Locally persisted rows for pinned remote threads (a sqlite read). */
  listRemoteThreadPins: () => Promise<ReadonlyArray<RemoteThreadPin>>;
};

/**
 * Name every blocker row from what this machine already knows, including what
 * it knows about its peers.
 *
 * This is cache-only local plus cache-only remote resolution. The old lookup
 * asked this instance's full thread list, which both delayed quit and could
 * not answer for a peer's thread.
 *
 * Reaching the peer (tier 3) is deliberately NOT done here. A remote thread
 * is a quit blocker because a window on this machine has its terminal open,
 * which means some snapshot named it on the way to the screen — so the name
 * is normally already in hand, and a round trip would re-answer a question we
 * can answer while making shutdown wait on a machine that may be asleep.
 *
 * Two cached sources, both local reads: the remembered names from every peer
 * snapshot this instance has seen, and the pinned rows' persisted summaries
 * (which survive a restart, so a freshly launched app can still name a pinned
 * remote thread before anything has talked to that peer).
 *
 * Neither is a guarantee. A peer's thread that no snapshot has named on this
 * instance — nothing pinned it and no navigation read reached it — still
 * falls back to its thread id, which is the correct outcome: the alternative
 * is blocking shutdown on a peer to learn something cosmetic.
 *
 * Every lookup degrades to "no title" rather than throwing: a row that reads
 * as a thread id still links correctly, and nothing here is worth delaying a
 * quit over.
 */
export async function resolveQuitBlockerThreadTitles(
  items: readonly QuitBlockerItem[],
  dependencies: QuitBlockerTitleResolverDependencies,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const localItems = items.filter((item) => !item.target);
  const remoteItems = items.flatMap((item) =>
    item.target ? [{ item, target: item.target }] : [],
  );

  const resolveLocal = (): void => {
    if (localItems.length === 0) return;
    for (const item of localItems) {
      try {
        record(
          titles,
          item,
          dependencies.cachedLocalThreadName({
            backend: item.backend as AppServerBackendKind,
            threadId: item.threadId,
          }),
        );
      } catch {
        // One unavailable cache entry must not prevent the remaining rows from
        // resolving or delay the quit decision.
      }
    }
  };

  const resolveRemote = async (): Promise<void> => {
    if (remoteItems.length === 0) return;
    const names = remoteItems.map(({ item, target }) => {
      try {
        return dependencies.cachedRemoteThreadName({
          target,
          backend: item.backend as AppServerBackendKind,
          threadId: item.threadId,
        });
      } catch {
        return undefined;
      }
    });
    // One store read for the whole batch, and only when the remembered names
    // left something unnamed — a fresh launch, typically, where no snapshot
    // has reached that peer yet.
    const pins = names.some((name) => !name)
      ? await dependencies
          .listRemoteThreadPins()
          .catch(() => [] as ReadonlyArray<RemoteThreadPin>)
      : [];
    const pinnedByTitleKey = new Map<string, NavigationThreadSummary>();
    for (const pin of pins) {
      if (pin.ref.target.scope !== "remote" || !pin.summary) continue;
      pinnedByTitleKey.set(
        quitBlockerTitleKey({
          threadKey: buildThreadIdentityKey(pin.ref.backend, pin.ref.threadId),
          target: pin.ref.target,
        }),
        pin.summary,
      );
    }
    remoteItems.forEach(({ item }, index) => {
      record(
        titles,
        item,
        names[index] ?? pinnedByTitleKey.get(quitBlockerTitleKey(item)),
      );
    });
  };

  // `resolveLocal` is synchronous and swallows its own failures per row, so
  // there is nothing here to await or to catch. The two write disjoint keys --
  // local rows carry no `target`, and the key includes it -- so order is free.
  resolveLocal();
  await resolveRemote().catch(() => undefined);
  return titles;
}

/** A "fallback" title IS the thread id, so recording it changes nothing but
 *  hides that the name is unknown. */
function record(
  titles: Map<string, string>,
  item: QuitBlockerItem,
  thread: QuitBlockerThreadTitle | undefined,
): void {
  if (!thread || thread.titleSource === "fallback") return;
  const title = thread.title?.trim();
  if (title) {
    titles.set(quitBlockerTitleKey(item), title);
  }
}

/** Split a canonical `buildThreadIdentityKey` back into its parts. Unparseable
 *  keys still render — they just link nowhere useful. */
function splitQuitThreadKey(threadKey: string): {
  backend: string;
  threadId: string;
} {
  const parsed = parseThreadIdentityKey(threadKey);
  return parsed ?? { backend: "", threadId: threadKey };
}

const quitLog = getMainLogger("pwragent:quit");

export function getCurrentQuitBlockers(): QuitBlockerSnapshot {
  return buildQuitBlockerSnapshot({
    inProgressThreads:
      getDesktopBackendRegistry().getInProgressThreadSnapshotForQuit(),
    terminalSessions: getIntegratedTerminalQuitSnapshot(),
    actionRuns: listRunningDetachedCommands(),
  });
}

async function resolveCurrentQuitBlockerTitles(
  items: QuitBlockerItem[],
): Promise<Map<string, string>> {
  return await resolveQuitBlockerThreadTitles(items, {
    cachedLocalThreadName: (params) =>
      getDesktopBackendRegistry().getThreadInfo(params),
    cachedRemoteThreadName: (params) =>
      getDesktopFederationRuntime()
        .remoteThreadSummaries()
        .cachedThreadNameFromPeer(params),
    listRemoteThreadPins: async () =>
      await getDesktopOverlayStore().listRemoteThreadPins(),
  });
}

export async function readQuitBlockerQueueSnapshot(): Promise<
  QuitBlockerQueueSnapshot
> {
  return await buildQuitConfirmationSnapshot(
    getCurrentQuitBlockers(),
    resolveCurrentQuitBlockerTitles,
    quitLog,
  );
}

export const appQuitManager = createQuitManager({
  focusPendingConfirmation: () => focusActiveQuitConfirmationDialog(),
  getConfirmationEnabled: () =>
    getDesktopSettingsService().resolveConfirmQuitWithInProgressThreads(),
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  getQuitBlockers: getCurrentQuitBlockers,
  quiesceAutomationDispatch: () =>
    getDesktopAutomationService().quiesceDispatch(),
  // Map/store reads only, no peer round trip. Names remembered from peer
  // snapshots keep remote blockers readable without delaying shutdown.
  resolveThreadTitles: resolveCurrentQuitBlockerTitles,
  log: quitLog,
  performQuit: () => {
    app.quit();
  },
});

export async function requestQuit(
  options: RequestQuitOptions,
): Promise<boolean> {
  return await appQuitManager.requestQuit(options);
}
