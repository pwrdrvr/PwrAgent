import { useCallback, useEffect, useState } from "react";
import type { DecisionProvidersReadiness } from "@pwragent/shared/decision-models";
import type { ResearchDecisionsSnapshot, ResearchThread } from "@pwragent/shared/research";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../lib/desktop-api";
import { decisionSetupReadiness } from "../thread-detail/context-panels/decision-setup";
import { isDecisionBatchRunning } from "../thread-detail/context-panels/decisions-format";

const RUNNING_POLL_MS = 2_000;
const IDLE_LIVE_POLL_MS = 10_000;

/**
 * Decision provider readiness for Research setup and run views. Prefers the
 * window's live Settings snapshot when available, falling back to the owner's
 * read-only IPC probe (used by ResearchWindow and standalone surfaces).
 */
export function useResearchDecisionsStatus(
  api?: Pick<DesktopApi, "readResearchDecisionsStatus">,
  settingsSnapshot?: DesktopSettingsSnapshot,
): DecisionProvidersReadiness | undefined {
  const fromSettings = decisionSetupReadiness(settingsSnapshot);
  const read = api?.readResearchDecisionsStatus;
  const [fetched, setFetched] = useState<DecisionProvidersReadiness>();

  useEffect(() => {
    if (fromSettings || !read) return;
    let disposed = false;
    void read().then(
      (result) => { if (!disposed) setFetched(result); },
      () => {},
    );
    return () => { disposed = true; };
  }, [fromSettings, read]);

  return fromSettings ?? fetched;
}

export type ResearchDecisionsState = {
  snapshot?: ResearchDecisionsSnapshot;
  error: boolean;
  available: boolean;
  refresh: () => void;
};

/**
 * Run-scoped decisions and all member batches (coordinator + workers) for one
 * research run. Refreshes on run revisions, on live decision batch events for
 * any member of the run, and on a light poll while batches or the run are live.
 */
export function useResearchDecisions(params: {
  api?: Pick<DesktopApi, "readResearchDecisions" | "onAgentEvent">;
  thread?: ResearchThread;
  runId?: string;
  revision?: number;
  live: boolean;
  open: boolean;
  memberThreadKeys?: ReadonlySet<string>;
}): ResearchDecisionsState {
  const read = params.api?.readResearchDecisions;
  const backend = params.thread?.backend;
  const threadId = params.thread?.threadId;
  const runId = params.runId;
  const available = Boolean(read && backend && threadId && runId);
  const key = backend && threadId && runId ? `${backend}:${threadId}:${runId}` : undefined;
  const [state, setState] = useState<{ key?: string; snapshot?: ResearchDecisionsSnapshot; error: boolean }>({ error: false });
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  const subscribe = params.api?.onAgentEvent;
  const memberThreadKeys = params.memberThreadKeys;
  useEffect(() => {
    if (!available || !subscribe || !backend || !threadId) return;
    return subscribe((event) => {
      if (event.federationTarget?.scope === "remote") return;
      if (event.notification.method !== "thread/decisionBatches/updated") return;
      const eventThreadId = event.notification.params.threadId;
      const eventKey = `${event.backend}:${eventThreadId}`;
      if (eventKey === `${backend}:${threadId}` || memberThreadKeys?.has(eventKey)) {
        refresh();
      }
    });
  }, [available, backend, memberThreadKeys, refresh, subscribe, threadId]);

  useEffect(() => {
    if (!available || !read || !backend || !threadId || !runId || !key) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      let next: ResearchDecisionsSnapshot | undefined;
      try {
        next = await read({ backend, threadId, runId });
        if (!disposed) setState({ key, snapshot: next, error: false });
      } catch {
        if (!disposed) {
          setState((current) => ({
            key,
            snapshot: current.key === key ? current.snapshot : undefined,
            error: true,
          }));
        }
      } finally {
        if (!disposed) {
          const hasRunning = next?.batches.some(isDecisionBatchRunning) ?? false;
          const delay = hasRunning
            ? RUNNING_POLL_MS
            : params.open && params.live
              ? IDLE_LIVE_POLL_MS
              : undefined;
          if (delay !== undefined) {
            timer = setTimeout(() => { void load(); }, delay);
          }
        }
      }
    };
    void load();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [available, backend, key, params.live, params.open, params.revision, read, refreshToken, runId, threadId]);

  const current = state.key === key;
  return {
    ...(current && state.snapshot ? { snapshot: state.snapshot } : {}),
    error: current && state.error,
    available,
    refresh,
  };
}
