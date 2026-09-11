import { useEffect, useMemo, useRef, useState } from "react";
import type { AppServerReadThreadResponse, AppServerThreadEntry, AppServerThreadActivityEntry, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { readRendererFederationTarget } from "./federation-window";

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

export function useThreadUsageDisplay(params: {
  desktopApi?: DesktopApi;
  thread?: NavigationThreadSummary;
  entries: AppServerThreadEntry[];
  response?: AppServerReadThreadResponse;
  suspended?: boolean;
}) {
  const target = params.thread?.federation?.ref.target ?? readRendererFederationTarget();
  const key = JSON.stringify([params.thread?.source, params.thread?.id, target, params.response?.display?.revision]);
  const current = useRef(params);
  current.current = params;
  const [state, setState] = useState<{ key: string; entries: AppServerThreadActivityEntry[] }>({ key, entries: [] });
  useEffect(() => {
    const { desktopApi, thread, suspended, response } = current.current;
    const effectTarget = thread?.federation?.ref.target ?? readRendererFederationTarget();
    if (!response?.display || suspended || !desktopApi?.readThread || !thread) return;
    let cancelled = false;
    let version = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const sequence = ++version;
      const turns = [...new Map(current.current.entries.flatMap((entry) => entry.turn ? [[entry.turn.id, entry.turn] as const] : [])).values()];
      const activities: AppServerThreadActivityEntry[] = [];
      try {
        // Loaded history, not total thread length, bounds this resource.
        for (let offset = 0; offset < turns.length; offset += 256) {
          const response = await desktopApi.readThread!({
            backend: thread.source, threadId: thread.id,
            federationTarget: effectTarget,
            display: { resource: "accounting", turns: turns.slice(offset, offset + 256) },
            includeTurns: false, viewOnly: true,
          });
          if (cancelled || sequence !== version) return;
          activities.push(...response.replay.entries.filter((entry): entry is AppServerThreadActivityEntry => entry.type === "activity"));
        }
        if (!cancelled && sequence === version) setState({ key, entries: activities });
      } catch {
        // Keep the previous owner projection; the next boundary or reconnect retries.
      }
    };
    const schedule = () => {
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
      if (fields.threadId === thread.id
        && ["thread/pricing/updated", "turn/completed"].includes(event.notification.method)) schedule();
    });
    schedule();
    return () => { cancelled = true; version += 1; if (timer) clearTimeout(timer); unsubscribe?.(); };
  }, [key, params.response?.display?.revision, params.desktopApi, params.suspended]);
  return useMemo(() => applyThreadUsageDisplay(params.entries, state.key === key ? state.entries : []), [params.entries, key, state]);
}
