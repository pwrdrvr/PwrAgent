import { app, BrowserWindow } from "electron";
import {
  buildThreadIdentityKey,
  parseThreadIdentityKey,
  type AppServerBackendKind,
} from "@pwragent/shared";
import { getDesktopBackendRegistry } from "./app-server/backend-registry";
import {
  listRunningDetachedCommands,
  type DetachedCommandSummary,
} from "./app-server/codex-environment-runtime";
import { getIntegratedTerminalQuitSnapshot } from "./ipc/integrated-terminal";
import { getMainLogger } from "./log";
import { getDesktopSettingsService } from "./settings/desktop-settings-singleton";
import {
  showQuitConfirmationDialog,
  type QuitBlockerItem,
  type QuitConfirmationDialogResult,
} from "./quit-confirmation-dialog";

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
  }) => Promise<QuitConfirmationDialogResult>;
  getConfirmationEnabled: () => boolean;
  getFocusedWindow?: () => BrowserWindow | null;
  getQuitBlockers: () => QuitBlockerSnapshot;
  /** Best-effort thread-title lookup for the dialog's links. */
  resolveThreadTitles?: (
    threadKeys: string[],
  ) => Promise<Map<string, string>>;
  log: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
  performQuit: () => void;
};

/** Titles are a nicety; quitting must not hang on a slow app-server. */
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
      return await promptPromise;
    }

    dependencies.log.warn?.("quit requested with active work", {
      count: snapshot.count,
      actionRunCount: snapshot.actionRunCount,
      source: options.source,
      terminalSessionCount: snapshot.terminalSessionCount,
      terminalThreadKeys: snapshot.terminalThreadKeys,
      threadIds: snapshot.threadIds,
    });

    pendingPerformQuit = options.performQuit ?? dependencies.performQuit;
    promptPromise = (async () => {
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
      const resolution = await (dependencies.confirm ?? showQuitConfirmationDialog)({
        countdownSeconds: QUIT_CONFIRMATION_COUNTDOWN_SECONDS,
        inProgressThreadCount: snapshot.threadIds.length,
        terminalSessionCount: snapshot.terminalSessionCount,
        actionRunCount: snapshot.actionRunCount,
        items,
        parent: dependencies.getFocusedWindow?.(),
      });
      dependencies.log.warn?.("quit confirmation resolved", {
        count: snapshot.count,
        actionRunCount: snapshot.actionRunCount,
        resolution,
        source: options.source,
        terminalSessionCount: snapshot.terminalSessionCount,
        terminalThreadKeys: snapshot.terminalThreadKeys,
        threadIds: snapshot.threadIds,
      });
      if (resolution === "manual-cancel") {
        pendingPerformQuit = undefined;
        return false;
      }
      quitAllowed = true;
      (pendingPerformQuit ?? dependencies.performQuit)();
      pendingPerformQuit = undefined;
      return true;
    })().finally(() => {
      promptPromise = undefined;
    });

    return await promptPromise;
  };

  return {
    allowImmediateQuit: () => {
      quitAllowed = true;
    },
    isQuitAllowed: () => quitAllowed,
    requestQuit,
  };
}

export function buildQuitBlockerSnapshot(params: {
  inProgressThreads: {
    count: number;
    threadIds: string[];
  };
  terminalSessions: {
    count: number;
    threadKeys: string[];
  };
  actionRuns?: DetachedCommandSummary[];
}): QuitBlockerSnapshot {
  const threadIds = [...params.inProgressThreads.threadIds].sort();
  const terminalThreadKeys = [...params.terminalSessions.threadKeys].sort();
  const actionRuns = params.actionRuns ?? [];

  const items: QuitBlockerItem[] = [
    ...threadIds.map((threadKey) => ({
      kind: "turn" as const,
      ...splitQuitThreadKey(threadKey),
      threadKey,
    })),
    ...terminalThreadKeys.map((threadKey) => ({
      kind: "terminal" as const,
      ...splitQuitThreadKey(threadKey),
      threadKey,
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
    count: threadIds.length + params.terminalSessions.count + actionRuns.length,
    terminalSessionCount: params.terminalSessions.count,
    terminalThreadKeys,
    threadIds,
    actionRunCount: actionRuns.length,
    items,
  };
}

/**
 * Attach thread titles to the blocker rows, bounded by a timeout: a hung
 * app-server must not be able to wedge shutdown. On timeout or failure the rows
 * keep their thread ids, which still link correctly — they just read worse.
 */
async function withResolvedTitles(
  items: QuitBlockerItem[],
  resolve: QuitManagerDependencies["resolveThreadTitles"],
  log: QuitManagerDependencies["log"],
): Promise<QuitBlockerItem[]> {
  if (!resolve || items.length === 0) {
    return items;
  }
  const threadKeys = [...new Set(items.map((item) => item.threadKey))];
  let titles: Map<string, string>;
  try {
    titles = await Promise.race([
      resolve(threadKeys),
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
    const title = titles.get(item.threadKey);
    return title ? { ...item, title } : item;
  });
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

export const appQuitManager = createQuitManager({
  getConfirmationEnabled: () =>
    getDesktopSettingsService().resolveConfirmQuitWithInProgressThreads(),
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  getQuitBlockers: () =>
    buildQuitBlockerSnapshot({
      inProgressThreads:
        getDesktopBackendRegistry().getInProgressThreadSnapshotForQuit(),
      terminalSessions: getIntegratedTerminalQuitSnapshot(),
      actionRuns: listRunningDetachedCommands(),
    }),
  resolveThreadTitles: async (threadKeys) => {
    const wanted = new Set(threadKeys);
    const threads = await getDesktopBackendRegistry().listThreads({
      callerReason: "quit-confirmation",
    });
    const titles = new Map<string, string>();
    for (const thread of threads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      if (wanted.has(threadKey) && thread.title) {
        titles.set(threadKey, thread.title);
      }
    }
    return titles;
  },
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
