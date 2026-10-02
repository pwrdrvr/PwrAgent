import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexBackgroundTerminal, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { agentEventThreadIdentityKey, threadSummaryIdentityKey } from "./federated-thread-events";
import { readRendererFederationTarget } from "./federation-window";

export type BackgroundTerminalView = CodexBackgroundTerminal & { output?: string };
const OUTPUT_LIMIT = 32_768;
const REFRESH_INTERVAL_MS = 5_000;

/** All state is window-local. Codex owns the sessions and their lifetime. */
export function useCodexBackgroundTerminals(params: {
  desktopApi?: DesktopApi;
  thread?: NavigationThreadSummary;
  suspended?: boolean;
  retainedRemoteThreadKeys?: ReadonlySet<string>;
}) {
  const { desktopApi, suspended } = params;
  const threadKey = params.thread ? threadSummaryIdentityKey(params.thread) : undefined;
  const threadRef = useRef(params.thread);
  threadRef.current = params.thread;
  const [byThread, setByThread] = useState<Record<string, BackgroundTerminalView[]>>({});
  const byThreadRef = useRef(byThread);
  byThreadRef.current = byThread;
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState<string>();
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const retainedRemoteKeysJson = params.retainedRemoteThreadKeys === undefined
    ? undefined : JSON.stringify([...params.retainedRemoteThreadKeys].sort());
  const previousRemoteKeysRef = useRef(new Set<string>());

  useEffect(() => {
    if (retainedRemoteKeysJson === undefined) return;
    const keys = new Set<string>(JSON.parse(retainedRemoteKeysJson));
    const target = threadRef.current?.federation?.ref.target ?? readRendererFederationTarget();
    // The selected thread still has transcript interest even if it cannot
    // enter the recent-thread LRU. Local terminal caches keep their lifetime.
    if (target?.scope === "remote" && threadKey) keys.add(threadKey);
    const evicted = [...previousRemoteKeysRef.current].filter((key) => !keys.has(key));
    previousRemoteKeysRef.current = keys;
    if (!evicted.length) return;
    setByThread((current) => {
      if (!evicted.some((key) => key in current)) return current;
      const next = { ...current };
      for (const key of evicted) delete next[key];
      return next;
    });
  }, [retainedRemoteKeysJson, threadKey]);

  useEffect(() => {
    setError(undefined);
    setStopping(undefined);
    const thread = threadRef.current;
    const list = desktopApi?.listBackgroundTerminals;
    if (suspended || !list) return;
    const request = thread?.source === "codex" ? {
      backend: thread.source,
      threadId: thread.id,
      federationTarget: thread.federation?.ref.target ?? readRendererFederationTarget(),
    } : undefined;
    let cancelled = false;
    let inFlight = false;
    let dirty = false;
    let supported = true;
    let revision = 0;
    const refresh = async (): Promise<void> => {
      if (cancelled || !supported || !request || !threadKey) return;
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      try {
        do {
          dirty = false;
          const readRevision = revision;
          const response = await list(request);
          if (cancelled) return;
          if (readRevision !== revision) { dirty = true; continue; }
          supported = response.supported;
          setByThread((current) => {
            const previous = current[threadKey] ?? [];
            const terminals = response.terminals.map((terminal) => ({
              ...terminal,
              output: previous.find((item) => item.itemId === terminal.itemId)?.output,
            }));
            const next = { ...current };
            if (terminals.length) next[threadKey] = terminals;
            else delete next[threadKey];
            return next;
          });
          setError(undefined);
        } while (dirty && supported && !cancelled);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        inFlight = false;
        // A recovery notification may race with the old disconnected read
        // rejecting. Honor that queued refresh even when the read failed.
        if (dirty && !cancelled && supported) void refresh();
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      const notification = event.notification;
      if (notification.method === "federation/eventStream/changed"
        || (notification.method === "federation/peerStatus/changed" && notification.params.status === "connected")) {
        const target = request?.federationTarget;
        if (target?.scope === "remote" && target.instanceId === notification.params.instanceId) {
          // Recovery can be the first chance to discover a session. Do not
          // depend on an existing cache entry or a thread-scoped event.
          revision += 1;
          void refresh();
        }
        return;
      }
      const eventParams = notification.params;
      if (!("threadId" in eventParams) || typeof eventParams.threadId !== "string") return;
      const key = agentEventThreadIdentityKey(event, eventParams.threadId);
      if (event.backend !== "codex") return;
      if (notification.method === "item/commandExecution/outputDelta") {
        const { itemId, delta } = notification.params;
        setByThread((current) => {
          if (!current[key]?.some((terminal) => terminal.itemId === itemId)) return current;
          return { ...current, [key]: current[key].map((terminal) => terminal.itemId === itemId
            ? { ...terminal, output: ((terminal.output ?? "") + delta).slice(-OUTPUT_LIMIT) }
            : terminal) };
        });
        return;
      }
      if (notification.method === "item/completed") {
        const item = notification.params.item as { id?: string } | undefined;
        setByThread((current) => {
          if (!item?.id || !current[key]?.some((terminal) => terminal.itemId === item.id)) return current;
          const remaining = current[key].filter((terminal) => terminal.itemId !== item.id);
          const next = { ...current };
          if (remaining.length) next[key] = remaining;
          else delete next[key];
          return next;
        });
      }
      if (notification.method === "thread/status/changed" && typeof notification.params.status === "object"
        && notification.params.status !== null && "type" in notification.params.status
        && notification.params.status.type === "notLoaded") {
        setByThread((current) => { const next = { ...current }; delete next[key]; return next; });
        if (key === threadKey) revision += 1;
        return;
      }
      if (key === threadKey && ["item/started", "item/completed", "turn/completed", "turn/failed", "turn/cancelled"].includes(notification.method)) {
        revision += 1;
        void refresh();
      }
    });
    // Reconcile resource usage and exits for the selected thread only while
    // it owns live terminals. No timer runs commands or writes to SQLite.
    const timer = setInterval(() => {
      if (threadKey && byThreadRef.current[threadKey]?.length) void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe?.();
      if (refreshRef.current === refresh) refreshRef.current = async () => undefined;
    };
  }, [desktopApi, threadKey, suspended]);

  const stop = useCallback(async (terminal: CodexBackgroundTerminal): Promise<void> => {
    // Capture the rendered row's owner. A click queued during a selection
    // change must never send an old session handle to the new thread.
    const thread = params.thread;
    const terminate = desktopApi?.terminateBackgroundTerminal;
    if (!thread || !terminate) return;
    const key = threadSummaryIdentityKey(thread);
    if (threadRef.current && threadSummaryIdentityKey(threadRef.current) === key) {
      setStopping(terminal.processId);
      setError(undefined);
    }
    try {
      await terminate({
        backend: thread.source, threadId: thread.id, processId: terminal.processId,
        federationTarget: thread.federation?.ref.target ?? readRendererFederationTarget(),
      });
      if (threadRef.current && threadSummaryIdentityKey(threadRef.current) === key) await refreshRef.current();
    } catch (failure) {
      if (threadRef.current && threadSummaryIdentityKey(threadRef.current) === key) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (threadRef.current && threadSummaryIdentityKey(threadRef.current) === key) setStopping(undefined);
    }
  }, [desktopApi, params.thread]);

  return { byThread, terminals: threadKey ? byThread[threadKey] ?? [] : [], error, stopping, stop };
}
