import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FederationRemoteTarget } from "@pwragent/shared";
import type {
  IntegratedTerminalRemoteInfo,
  IntegratedTerminalSessionSummary,
} from "../../../shared/integrated-terminal";
import type { DesktopApi } from "./desktop-api";

/**
 * Renderer mirror of the main process's live PTY registry.
 *
 * This hook MUST be instantiated above `ThreadView` in the tree. `ThreadView`
 * unmounts on ordinary navigation — opening the search screen, or any refresh
 * that transiently drops the selected thread and flips `threadDetailPending`.
 * Terminal state used to live in its `useState`, so those unmounts silently
 * orphaned every running shell: main kept the PTY, the UI forgot it existed,
 * and the only remaining evidence was the quit dialog's blocker count.
 *
 * Main is now the single owner. We hydrate from `listIntegratedTerminals()` on
 * mount and follow the `sessions` broadcast after that, so a remount — or a
 * full renderer reload — re-discovers whatever is still running and reattaches
 * to it (`createOrAttach` replays the session's scrollback buffer).
 *
 * A "local" pane covers the gap before main has a session to report: the pane
 * has to be mounted for it to call `createIntegratedTerminal` in the first
 * place. Once the session lands, main's record takes over — including the
 * `panelHidden` bit, which is why collapsing a terminal survives a remount.
 */

/**
 * A pane's remote-terminal identity: the target the create request must
 * name (the shell runs on that instance), plus the label + celestial icon
 * that keep the pane visibly branded as the remote machine's shell.
 */
export type IntegratedTerminalPaneRemote = IntegratedTerminalRemoteInfo & {
  target: FederationRemoteTarget;
};

type LocalPane = {
  threadKey: string;
  cwd?: string;
  hidden: boolean;
  remote?: IntegratedTerminalPaneRemote;
};

export type IntegratedTerminalPane = {
  threadKey: string;
  /**
   * The terminal this pane is showing, once main has reported one. Panes are
   * still one-per-thread here — a pane keyed by terminal needs the tab strip
   * that has yet to be built — but every request main answers is addressed by
   * terminal, so the pane sends this rather than its thread wherever it has
   * one.
   */
  sessionId?: string;
  cwd?: string;
  remote?: IntegratedTerminalPaneRemote;
};

export type IntegratedTerminalsController = {
  sessions: IntegratedTerminalSessionSummary[];
  /** Threads with a live PTY, whether or not the panel is showing. */
  liveThreadKeys: ReadonlySet<string>;
  /** Threads running a PTY behind a collapsed panel — these need an indicator. */
  hiddenThreadKeys: ReadonlySet<string>;
  panes: IntegratedTerminalPane[];
  heightByThread: Record<string, number>;
  isPanelOpen: (threadKey: string) => boolean;
  togglePanel: (
    threadKey: string,
    cwd?: string,
    remote?: IntegratedTerminalPaneRemote,
  ) => void;
  /** Show the panel; a no-op when it is already showing. */
  openPanel: (
    threadKey: string,
    cwd?: string,
    remote?: IntegratedTerminalPaneRemote,
  ) => void;
  closeTerminal: (pane: { threadKey: string; sessionId?: string }) => void;
  handleExit: (threadKey: string) => void;
  setHeight: (threadKey: string, height: number) => void;
};

export function useIntegratedTerminals(
  desktopApi: DesktopApi | undefined,
): IntegratedTerminalsController {
  const [sessions, setSessions] = useState<IntegratedTerminalSessionSummary[]>(
    [],
  );
  const [localPanes, setLocalPanes] = useState<Record<string, LocalPane>>({});
  // Read by the hand-off effect so it can compute its IPC calls without doing
  // work inside a setState updater.
  const localPanesRef = useRef(localPanes);
  localPanesRef.current = localPanes;
  const [heightByThread, setHeightByThread] = useState<Record<string, number>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    // Subscribe BEFORE hydrating, and let any broadcast win over the in-flight
    // list: a create/exit landing while `listIntegratedTerminals()` is in the
    // air would otherwise be clobbered by the older snapshot when it resolves.
    let broadcastApplied = false;
    const unsubscribe = desktopApi?.onIntegratedTerminalSessions?.((event) => {
      broadcastApplied = true;
      setSessions(event.sessions);
    });
    void desktopApi?.listIntegratedTerminals?.().then((next) => {
      if (!cancelled && !broadcastApplied) setSessions(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi]);

  // Grouped, not one-to-one: a thread owns any number of terminals now, and
  // the thread-level affordances below (the panel toggle, the "running"
  // indicator) have to answer for all of them.
  const sessionsByThread = useMemo(() => {
    const next = new Map<string, IntegratedTerminalSessionSummary[]>();
    for (const session of sessions) {
      const group = next.get(session.threadKey);
      if (group) {
        group.push(session);
      } else {
        next.set(session.threadKey, [session]);
      }
    }
    return next;
  }, [sessions]);

  // Hand a thread off to main as soon as it has a session. If the user
  // collapsed the pane while `create` was still in flight, carry that choice
  // over rather than letting the arriving session pop it back open.
  //
  // The IPC happens in the effect body, NOT inside the updater: updaters must
  // be pure. StrictMode double-invokes them, so a side effect in there fires
  // the IPC twice.
  useEffect(() => {
    const settled = Object.values(localPanesRef.current).filter((pane) =>
      sessionsByThread.has(pane.threadKey),
    );
    if (settled.length === 0) return;

    for (const pane of settled) {
      if (!pane.hidden) continue;
      for (const session of sessionsByThread.get(pane.threadKey) ?? []) {
        if (session.panelHidden) continue;
        void desktopApi?.setIntegratedTerminalPanelHidden?.({
          sessionId: session.sessionId,
          hidden: true,
        });
      }
    }

    const settledKeys = new Set(settled.map((pane) => pane.threadKey));
    setLocalPanes((current) => {
      const next = { ...current };
      let changed = false;
      for (const threadKey of settledKeys) {
        if (threadKey in next) {
          delete next[threadKey];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [desktopApi, sessionsByThread]);

  const liveThreadKeys = useMemo(
    () => new Set(sessions.map((session) => session.threadKey)),
    [sessions],
  );
  // "Running behind a collapsed panel" means the thread is showing none of
  // its terminals. One visible terminal is not a hidden thread, however many
  // others sit collapsed beside it.
  const hiddenThreadKeys = useMemo(() => {
    const next = new Set<string>();
    for (const [threadKey, group] of sessionsByThread) {
      if (group.every((session) => session.panelHidden)) {
        next.add(threadKey);
      }
    }
    return next;
  }, [sessionsByThread]);

  const panes = useMemo<IntegratedTerminalPane[]>(
    () => [
      // One pane per thread, showing the thread's oldest terminal — the same
      // one `createOrAttach` picks for a request that names none, so the pane
      // and main agree on which shell it is. Several panes for one thread is
      // the tab strip's job, and giving them stable React identities across
      // the local-pane hand-off is a design that work has to make.
      ...[...sessionsByThread.values()].flatMap((group) => {
        const session = group[0];
        if (!session) return [];
        return [
          {
            threadKey: session.threadKey,
            sessionId: session.sessionId,
            cwd: session.cwd,
            // A rediscovered remote session (remount, renderer reload) carries
            // its owning instance in the summary — rebuild the pane's target
            // from it so re-attaches keep routing to the peer.
            ...(session.remote
              ? {
                  remote: {
                    ...session.remote,
                    target: {
                      scope: "remote" as const,
                      instanceId: session.remote.instanceId,
                    },
                  },
                }
              : {}),
          },
        ];
      }),
      ...Object.values(localPanes)
        .filter((pane) => !sessionsByThread.has(pane.threadKey))
        .map((pane) => ({
          threadKey: pane.threadKey,
          cwd: pane.cwd,
          ...(pane.remote ? { remote: pane.remote } : {}),
        })),
    ],
    [localPanes, sessionsByThread],
  );

  const isPanelOpen = useCallback(
    (threadKey: string): boolean => {
      const group = sessionsByThread.get(threadKey);
      // Showing any one of the thread's terminals counts as open: the button
      // this answers for offers to put them away, and there is something to
      // put away.
      if (group) return group.some((session) => !session.panelHidden);
      const local = localPanes[threadKey];
      return local ? !local.hidden : false;
    },
    [localPanes, sessionsByThread],
  );
  const isPanelOpenRef = useRef(isPanelOpen);
  isPanelOpenRef.current = isPanelOpen;

  const setHidden = useCallback(
    (
      threadKey: string,
      hidden: boolean,
      cwd?: string,
      remote?: IntegratedTerminalPaneRemote,
    ) => {
      const group = sessionsByThread.get(threadKey);
      if (group) {
        // Collapsing is a preference, not a teardown: the PTY keeps running
        // and main remembers the choice across remounts. Thread-level, so it
        // moves every terminal the thread owns — the toggle it serves says
        // "this thread's terminal", not "this shell".
        for (const session of group) {
          void desktopApi?.setIntegratedTerminalPanelHidden?.({
            sessionId: session.sessionId,
            hidden,
          });
        }
        return;
      }
      setLocalPanes((current) => {
        const existing = current[threadKey];
        if (existing && existing.hidden === hidden) return current;
        return {
          ...current,
          [threadKey]: {
            threadKey,
            cwd: existing?.cwd ?? cwd,
            hidden,
            remote: existing?.remote ?? remote,
          },
        };
      });
    },
    [desktopApi, sessionsByThread],
  );

  const togglePanel = useCallback(
    (threadKey: string, cwd?: string, remote?: IntegratedTerminalPaneRemote) => {
      setHidden(threadKey, isPanelOpenRef.current(threadKey), cwd, remote);
    },
    [setHidden],
  );

  const openPanel = useCallback(
    (threadKey: string, cwd?: string, remote?: IntegratedTerminalPaneRemote) => {
      setHidden(threadKey, false, cwd, remote);
    },
    [setHidden],
  );

  const dropLocalPane = useCallback((threadKey: string) => {
    setLocalPanes((current) => {
      if (!(threadKey in current)) return current;
      const next = { ...current };
      delete next[threadKey];
      return next;
    });
  }, []);

  const closeTerminal = useCallback(
    (pane: { threadKey: string; sessionId?: string }) => {
      dropLocalPane(pane.threadKey);
      // Name the terminal when the pane knows it. The thread key is the
      // fallback for a pane whose create has yet to resolve, and main reads it
      // as "close this thread's terminals" — which is what a pane with no id
      // of its own can ask for.
      void desktopApi?.closeIntegratedTerminal?.(
        pane.sessionId
          ? { sessionId: pane.sessionId }
          : { threadKey: pane.threadKey },
      );
    },
    [desktopApi, dropLocalPane],
  );

  // The PTY died on its own. Main drops it from the registry and broadcasts;
  // all we owe is tearing down any pane we were holding locally.
  const handleExit = useCallback(
    (threadKey: string) => {
      dropLocalPane(threadKey);
    },
    [dropLocalPane],
  );

  const setHeight = useCallback((threadKey: string, height: number) => {
    setHeightByThread((current) => ({ ...current, [threadKey]: height }));
  }, []);

  // The quit dialog's terminal links land here: show me the shell, whatever the
  // remembered panel state was. Only ever for a session main still has — main
  // already refuses to broadcast otherwise, and `openPanel` on an unknown
  // thread would create a local pane, which spawns a whole new shell.
  const liveSessionIds = useMemo(
    () => new Set(sessions.map((session) => session.sessionId)),
    [sessions],
  );
  const liveSessionIdsRef = useRef(liveSessionIds);
  liveSessionIdsRef.current = liveSessionIds;
  useEffect(() => {
    const unsubscribe = desktopApi?.onIntegratedTerminalReveal?.((event) => {
      // Keyed on the terminal, not the thread: main un-hid one specific shell
      // and this converges on that, whatever else the thread is showing.
      if (!liveSessionIdsRef.current.has(event.sessionId)) {
        return;
      }
      void desktopApi?.setIntegratedTerminalPanelHidden?.({
        sessionId: event.sessionId,
        hidden: false,
      });
      // The pane itself may still be local-only in this window, in which case
      // main's record is not what is deciding whether it shows.
      if (!isPanelOpenRef.current(event.threadKey)) {
        openPanel(event.threadKey);
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [desktopApi, openPanel]);

  return {
    sessions,
    liveThreadKeys,
    hiddenThreadKeys,
    panes,
    heightByThread,
    isPanelOpen,
    togglePanel,
    openPanel,
    closeTerminal,
    handleExit,
    setHeight,
  };
}
