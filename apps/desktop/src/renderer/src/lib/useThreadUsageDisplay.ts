import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  AppServerThreadActivityEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import {
  THREAD_DISPLAY_LEGACY_MAX_ACCOUNTING_TURNS,
  THREAD_DISPLAY_MAX_ACCOUNTING_TURNS,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopApi } from "./desktop-api";
import { readRendererFederationTarget } from "./federation-window";
import { supportsBulkDisplayReads } from "./thread-display-bulk-reads";

/** Place owner-prepared usage activities next to their loaded turns. No ledger arithmetic. */
export function applyThreadUsageDisplay(entries: AppServerThreadEntry[], activities: AppServerThreadActivityEntry[]) {
  if (!activities.length) return entries;
  const byTurn = new Map(activities.flatMap((entry) => entry.turn?.id ? [[entry.turn.id, entry] as const] : []));
  const filtered = entries.filter((entry) => !(entry.type === "activity" && entry.turn?.id && byTurn.has(entry.turn.id)
    && (entry.id.startsWith("live-turn-usage-") || entry.id.startsWith("live-token-usage-") || /^(Turn usage|Latest request usage|Usage):/.test(entry.summary))));
  const lastIndex = new Map<string, number>();
  filtered.forEach((entry, index) => { if (entry.turn?.id) lastIndex.set(entry.turn.id, index); });
  return filtered.flatMap((entry, index) => {
    const usage = entry.turn?.id ? byTurn.get(entry.turn.id) : undefined;
    return usage && lastIndex.get(entry.turn!.id) === index ? [entry, usage] : [entry];
  });
}

type UsageDisplayRead = {
  readThread: NonNullable<DesktopApi["readThread"]>;
  thread: NavigationThreadSummary;
  target: FederationTarget | undefined;
  isCurrent?: () => boolean;
};

function indexTurns(entries: AppServerThreadEntry[]) {
  const turns = new Map<string, NonNullable<AppServerThreadEntry["turn"]>>();
  for (const entry of entries) {
    if (entry.turn) turns.set(entry.turn.id, entry.turn);
  }
  return turns;
}

export function readThreadUsageDisplay(params: UsageDisplayRead & { entries: AppServerThreadEntry[] }) {
  return readUsageForTurns(params, [...indexTurns(params.entries).values()]);
}

async function readUsageForTurns(
  { readThread, thread, target, isCurrent }: UsageDisplayRead,
  turns: NonNullable<AppServerThreadEntry["turn"]>[],
): Promise<AppServerThreadActivityEntry[]> {
  const activities: AppServerThreadActivityEntry[] = [];
  const chunk = supportsBulkDisplayReads(target, thread)
    ? THREAD_DISPLAY_MAX_ACCOUNTING_TURNS : THREAD_DISPLAY_LEGACY_MAX_ACCOUNTING_TURNS;
  for (let offset = 0; offset < turns.length; offset += chunk) {
    const response = await readThread({
      backend: thread.source, threadId: thread.id, federationTarget: target,
      display: { resource: "accounting", turns: turns.slice(offset, offset + chunk) },
      includeTurns: false, viewOnly: true,
    });
    if (isCurrent && !isCurrent()) return [];
    activities.push(...response.replay.entries.filter((entry): entry is AppServerThreadActivityEntry => entry.type === "activity"));
  }
  return activities;
}

export function useThreadUsageDisplay(params: {
  desktopApi?: DesktopApi;
  thread?: NavigationThreadSummary;
  entries: AppServerThreadEntry[];
  response?: AppServerReadThreadResponse;
  suspended?: boolean;
  onResolved?: (entries: AppServerThreadActivityEntry[]) => void;
}) {
  const target = params.thread?.federation?.ref.target ?? readRendererFederationTarget();
  const key = JSON.stringify([params.thread?.source, params.thread?.id, target, params.response?.display?.revision]);
  const current = useRef(params);
  current.current = params;
  const [state, setState] = useState<{ key: string; entries: AppServerThreadActivityEntry[] }>({ key, entries: [] });
  useEffect(() => {
    const { desktopApi, thread, suspended, response, onResolved } = current.current;
    const effectTarget = thread?.federation?.ref.target ?? readRendererFederationTarget();
    const readThread = desktopApi?.readThread;
    if (!response?.display || suspended || !readThread || !thread) return;
    let cancelled = false;
    let version = 0;
    let fullRefresh = true;
    let historyRevision: string | undefined;
    const dirtyTurns = new Set<string>();
    let indexedEntries: AppServerThreadEntry[] | undefined;
    let loadedTurns = new Map<string, NonNullable<AppServerThreadEntry["turn"]>>();
    let resolved: AppServerThreadActivityEntry[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const sequence = ++version;
      try {
        if (indexedEntries !== current.current.entries) {
          indexedEntries = current.current.entries;
          loadedTurns = indexTurns(indexedEntries);
        }
        const turns = fullRefresh ? [...loadedTurns.values()] : [...dirtyTurns].flatMap((id) => loadedTurns.get(id) ?? []);
        if (!fullRefresh && !turns.length) {
          dirtyTurns.clear();
          return;
        }
        const activities = await readUsageForTurns({
          readThread, thread, target: effectTarget, isCurrent: () => !cancelled && sequence === version,
        }, turns);
        if (cancelled || sequence !== version) return;
        if (fullRefresh) {
          resolved = activities;
        } else {
          resolved = resolved.filter(({ turn }) => turn && loadedTurns.has(turn.id) && !dirtyTurns.has(turn.id)).concat(activities);
        }
        fullRefresh = false;
        dirtyTurns.clear();
        onResolved?.(resolved);
        setState({ key, entries: resolved });
      } catch {
        // Keep the previous owner projection; the next boundary or reconnect retries.
      }
    };
    // Keep the complete dirty set until a current read succeeds. A new event
    // can invalidate an in-flight read after it has requested an earlier turn.
    const schedule = (turnIds?: readonly string[]) => {
      if (!turnIds) {
        fullRefresh = true;
        dirtyTurns.clear();
      } else if (!fullRefresh) {
        for (const id of turnIds) dirtyTurns.add(id);
      }
      version += 1;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 200);
    };
    const unsubscribe = desktopApi.onAgentEvent?.((event) => {
      const fields = event.notification.params as Record<string, unknown>;
      if (effectTarget?.scope === "remote" && fields.instanceId === effectTarget.instanceId
        && (event.notification.method === "federation/eventStream/changed"
          || (event.notification.method === "federation/peerStatus/changed" && fields.status === "connected"))) {
        schedule();
        return;
      }
      if (event.backend !== thread.source
        || (event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : undefined)
          !== (effectTarget?.scope === "remote" ? effectTarget.instanceId : undefined)) return;
      if (fields.threadId !== thread.id) return;
      if (event.notification.method === "thread/pricing/updated") {
        const ids = fields.changedTurnIds;
        const revision = typeof fields.pricingHistoryRevision === "string" ? fields.pricingHistoryRevision : undefined;
        const sameHistory = revision === historyRevision;
        historyRevision = revision;
        schedule(sameHistory && Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : undefined);
      }
      if (event.notification.method === "turn/completed") {
        schedule(historyRevision !== undefined && typeof fields.turnId === "string" ? [fields.turnId] : undefined);
      }
    });
    schedule();
    return () => { cancelled = true; version += 1; if (timer) clearTimeout(timer); unsubscribe?.(); };
  }, [key, params.response?.display?.revision, params.desktopApi, params.suspended]);
  return useMemo(() => applyThreadUsageDisplay(params.entries, state.key === key ? state.entries : []), [params.entries, key, state]);
}
