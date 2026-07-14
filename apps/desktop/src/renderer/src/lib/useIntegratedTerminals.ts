import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IntegratedTerminalSessionSummary } from "../../../shared/integrated-terminal";
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

type LocalPane = {
  threadKey: string;
  cwd?: string;
  hidden: boolean;
};

export type IntegratedTerminalPane = {
  threadKey: string;
  cwd?: string;
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
  togglePanel: (threadKey: string, cwd?: string) => void;
  /** Show the panel; a no-op when it is already showing. */
  openPanel: (threadKey: string, cwd?: string) => void;
  closeTerminal: (threadKey: string) => void;
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
  const [heightByThread, setHeightByThread] = useState<Record<string, number>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    void desktopApi?.listIntegratedTerminals?.().then((next) => {
      if (!cancelled) setSessions(next);
    });
    const unsubscribe = desktopApi?.onIntegratedTerminalSessions?.((event) => {
      setSessions(event.sessions);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi]);

  const sessionByThread = useMemo(() => {
    const next = new Map<string, IntegratedTerminalSessionSummary>();
    for (const session of sessions) {
      next.set(session.threadKey, session);
    }
    return next;
  }, [sessions]);

  // Hand a thread off to main as soon as it has a session. If the user
  // collapsed the pane while `create` was still in flight, carry that choice
  // over rather than letting the arriving session pop it back open.
  useEffect(() => {
    setLocalPanes((current) => {
      const settled = Object.values(current).filter((pane) =>
        sessionByThread.has(pane.threadKey),
      );
      if (settled.length === 0) return current;
      const next = { ...current };
      for (const pane of settled) {
        if (pane.hidden && !sessionByThread.get(pane.threadKey)?.panelHidden) {
          void desktopApi?.setIntegratedTerminalPanelHidden?.({
            threadKey: pane.threadKey,
            hidden: true,
          });
        }
        delete next[pane.threadKey];
      }
      return next;
    });
  }, [desktopApi, sessionByThread]);

  const liveThreadKeys = useMemo(
    () => new Set(sessions.map((session) => session.threadKey)),
    [sessions],
  );
  const hiddenThreadKeys = useMemo(
    () =>
      new Set(
        sessions
          .filter((session) => session.panelHidden)
          .map((session) => session.threadKey),
      ),
    [sessions],
  );

  const panes = useMemo<IntegratedTerminalPane[]>(
    () => [
      ...sessions.map((session) => ({
        threadKey: session.threadKey,
        cwd: session.cwd,
      })),
      ...Object.values(localPanes)
        .filter((pane) => !sessionByThread.has(pane.threadKey))
        .map((pane) => ({ threadKey: pane.threadKey, cwd: pane.cwd })),
    ],
    [localPanes, sessionByThread, sessions],
  );

  const isPanelOpen = useCallback(
    (threadKey: string): boolean => {
      const session = sessionByThread.get(threadKey);
      if (session) return !session.panelHidden;
      const local = localPanes[threadKey];
      return local ? !local.hidden : false;
    },
    [localPanes, sessionByThread],
  );
  const isPanelOpenRef = useRef(isPanelOpen);
  isPanelOpenRef.current = isPanelOpen;

  const setHidden = useCallback(
    (threadKey: string, hidden: boolean, cwd?: string) => {
      if (sessionByThread.has(threadKey)) {
        // Collapsing is a preference, not a teardown: the PTY keeps running
        // and main remembers the choice across remounts.
        void desktopApi?.setIntegratedTerminalPanelHidden?.({
          threadKey,
          hidden,
        });
        return;
      }
      setLocalPanes((current) => {
        const existing = current[threadKey];
        if (existing && existing.hidden === hidden) return current;
        return {
          ...current,
          [threadKey]: { threadKey, cwd: existing?.cwd ?? cwd, hidden },
        };
      });
    },
    [desktopApi, sessionByThread],
  );

  const togglePanel = useCallback(
    (threadKey: string, cwd?: string) => {
      setHidden(threadKey, isPanelOpenRef.current(threadKey), cwd);
    },
    [setHidden],
  );

  const openPanel = useCallback(
    (threadKey: string, cwd?: string) => {
      setHidden(threadKey, false, cwd);
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
    (threadKey: string) => {
      dropLocalPane(threadKey);
      void desktopApi?.closeIntegratedTerminal?.({ threadKey });
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

  // The quit dialog's terminal links land here: show me the shell, whatever
  // the remembered panel state was.
  useEffect(() => {
    const unsubscribe = desktopApi?.onIntegratedTerminalReveal?.((event) => {
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
