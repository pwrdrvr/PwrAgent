import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FederationRemoteTarget } from "@pwragent/shared";
import type { IntegratedTerminalRemoteInfo, IntegratedTerminalSessionSummary } from "../../../shared/integrated-terminal";
import type { DesktopApi } from "./desktop-api";

export type IntegratedTerminalPaneRemote = IntegratedTerminalRemoteInfo & { target: FederationRemoteTarget };
export type IntegratedTerminalPane = {
  threadKey: string;
  sessionId: string;
  cwd?: string;
  remote?: IntegratedTerminalPaneRemote;
  name?: string;
  shell?: string;
  status?: "running" | "exited" | "restored";
  exitCode?: number | null;
  pending?: boolean;
  newSession?: boolean;
};
type LocalPane = IntegratedTerminalPane & { hidden: boolean };
export type IntegratedTerminalsController = {
  sessions: IntegratedTerminalSessionSummary[];
  liveThreadKeys: ReadonlySet<string>;
  hiddenThreadKeys: ReadonlySet<string>;
  panes: IntegratedTerminalPane[];
  heightByThread: Record<string, number>;
  selectedByThread: Record<string, string>;
  selectTerminal: (threadKey: string, sessionId: string) => void;
  createTerminal: (threadKey: string, cwd?: string, remote?: IntegratedTerminalPaneRemote) => void;
  renameTerminal: (sessionId: string, name: string) => void;
  isPanelOpen: (threadKey: string) => boolean;
  togglePanel: (threadKey: string, cwd?: string, remote?: IntegratedTerminalPaneRemote) => void;
  openPanel: (threadKey: string, cwd?: string, remote?: IntegratedTerminalPaneRemote) => void;
  closeTerminal: (pane: { threadKey: string; sessionId?: string }) => void;
  handleExit: (threadKey: string) => void;
  setHeight: (threadKey: string, height: number) => void;
};

/** Main owns lifetime; this App-level mirror owns only window selection/layout.
 * Every pane is keyed by terminal, including before its asynchronous spawn. */
export function useIntegratedTerminals(desktopApi: DesktopApi | undefined): IntegratedTerminalsController {
  const [sessions, setSessions] = useState<IntegratedTerminalSessionSummary[]>([]);
  const [localPanes, setLocalPanes] = useState<Record<string, LocalPane>>({});
  const [heightByThread, setHeightByThread] = useState<Record<string, number>>({});
  const [selectedByThread, setSelectedByThread] = useState<Record<string, string>>({});
  const localRef = useRef(localPanes);
  localRef.current = localPanes;

  useEffect(() => {
    let cancelled = false;
    let broadcastApplied = false;
    const unsubscribe = desktopApi?.onIntegratedTerminalSessions?.((event) => {
      broadcastApplied = true;
      setSessions(event.sessions);
    });
    void desktopApi?.listIntegratedTerminals?.().then((next) => {
      if (!cancelled && !broadcastApplied) setSessions(next);
    }).catch(() => undefined);
    return () => { cancelled = true; unsubscribe?.(); };
  }, [desktopApi]);

  useEffect(() => {
    const settled = sessions.filter((session) => localRef.current[session.sessionId]);
    if (!settled.length) return;
    for (const session of settled) {
      if (localRef.current[session.sessionId]?.hidden) {
        void desktopApi?.setIntegratedTerminalPanelHidden?.({ sessionId: session.sessionId, hidden: true });
      }
    }
    setLocalPanes((current) => {
      const next = { ...current };
      for (const session of settled) delete next[session.sessionId];
      return next;
    });
  }, [desktopApi, sessions]);

  const panes = useMemo<IntegratedTerminalPane[]>(() => [
    ...sessions.map((session) => ({
      ...session,
      remote: session.remote ? {
        ...session.remote,
        target: { scope: "remote" as const, instanceId: session.remote.instanceId },
      } : undefined,
    })),
    ...Object.values(localPanes).filter((pane) => !sessions.some((session) => session.sessionId === pane.sessionId)),
  ], [sessions, localPanes]);
  const liveThreadKeys = useMemo(() => new Set(sessions
    .filter((session) => !session.status || session.status === "running")
    .map((session) => session.threadKey)), [sessions]);
  const hiddenThreadKeys = useMemo(() => new Set(sessions
    .filter((session) => session.panelHidden && !sessions.some((other) => other.threadKey === session.threadKey && !other.panelHidden))
    .map((session) => session.threadKey)), [sessions]);
  const isPanelOpen = useCallback((threadKey: string) =>
    sessions.some((session) => session.threadKey === threadKey && !session.panelHidden)
      || Object.values(localPanes).some((pane) => pane.threadKey === threadKey && !pane.hidden),
  [sessions, localPanes]);

  const selectTerminal = useCallback((threadKey: string, sessionId: string) => {
    setSelectedByThread((current) => ({ ...current, [threadKey]: sessionId }));
  }, []);
  const createTerminal = useCallback((threadKey: string, cwd?: string, remote?: IntegratedTerminalPaneRemote, newSession = true) => {
    const sessionId = crypto.randomUUID();
    setLocalPanes((current) => ({ ...current, [sessionId]: {
      threadKey, sessionId, cwd, remote, hidden: false, pending: true, newSession,
    } }));
    selectTerminal(threadKey, sessionId);
  }, [selectTerminal]);
  const setHidden = useCallback((threadKey: string, hidden: boolean, cwd?: string, remote?: IntegratedTerminalPaneRemote) => {
    const group = sessions.filter((session) => session.threadKey === threadKey && session.remote?.instanceId === remote?.instanceId);
    const pending = Object.values(localPanes).filter((pane) => pane.threadKey === threadKey && pane.remote?.instanceId === remote?.instanceId);
    if (!group.length && !pending.length) {
      if (!hidden) createTerminal(threadKey, cwd, remote, false);
      return;
    }
    for (const session of group) void desktopApi?.setIntegratedTerminalPanelHidden?.({ sessionId: session.sessionId, hidden });
    setLocalPanes((current) => {
      const next = { ...current };
      for (const pane of pending) next[pane.sessionId] = { ...pane, hidden };
      return next;
    });
  }, [sessions, localPanes, desktopApi, createTerminal]);
  const togglePanel = useCallback((threadKey: string, cwd?: string, remote?: IntegratedTerminalPaneRemote) => {
    setHidden(threadKey, isPanelOpen(threadKey), cwd, remote);
  }, [isPanelOpen, setHidden]);
  const openPanel = useCallback((threadKey: string, cwd?: string, remote?: IntegratedTerminalPaneRemote) => {
    setHidden(threadKey, false, cwd, remote);
  }, [setHidden]);
  const closeTerminal = useCallback((pane: { threadKey: string; sessionId?: string }) => {
    if (!pane.sessionId) return;
    const sessionId = pane.sessionId;
    setLocalPanes((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    void desktopApi?.closeIntegratedTerminal?.({ sessionId });
  }, [desktopApi]);
  const renameTerminal = useCallback((sessionId: string, name: string) => {
    void desktopApi?.renameIntegratedTerminal?.({ sessionId, name });
  }, [desktopApi]);
  const setHeight = useCallback((threadKey: string, height: number) => {
    setHeightByThread((current) => ({ ...current, [threadKey]: height }));
  }, []);
  useEffect(() => desktopApi?.onIntegratedTerminalReveal?.((event) => {
    if (!sessions.some((session) => session.sessionId === event.sessionId)) return;
    selectTerminal(event.threadKey, event.sessionId);
    void desktopApi?.setIntegratedTerminalPanelHidden?.({ sessionId: event.sessionId, hidden: false });
  }), [desktopApi, sessions, selectTerminal]);

  return {
    sessions, liveThreadKeys, hiddenThreadKeys, panes, heightByThread,
    selectedByThread, selectTerminal, createTerminal, renameTerminal,
    isPanelOpen, togglePanel, openPanel, closeTerminal,
    // Natural exit remains a tab containing its last screen.
    handleExit: () => undefined,
    setHeight,
  };
}
