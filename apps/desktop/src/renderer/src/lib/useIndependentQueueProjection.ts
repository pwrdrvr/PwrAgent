import { useEffect, useRef } from "react";
import type {
  ComposerThreadOwner,
  FederationTarget,
  NavigationQueueProjection,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadComposerScopeKey,
  type ComposerDraftStore,
} from "../features/composer/useComposerDraftStore";
import { resolveComposerScopeOwner } from "../features/composer/useOwnedComposerDraftStore";
import type { DesktopApi } from "./desktop-api";
import { readCompleteNavigationQueue, reconcileCompleteNavigationQueue } from "./navigation-queue-projection";

/** Complete FIFO reads follow local scope identities, independently of navigation pages. */
export function useIndependentQueueProjection(params: {
  composerDraftStore?: ComposerDraftStore;
  desktopApi?: DesktopApi;
  selectedThread?: NavigationThreadSummary;
  federationTarget?: FederationTarget;
}): void {
  const { desktopApi, composerDraftStore } = params;
  const current = useRef(params);
  current.current = params;
  const selectedKey = params.selectedThread
    ? JSON.stringify([params.selectedThread.source, params.selectedThread.id,
        params.selectedThread.federation?.ref.target ?? params.federationTarget ?? { scope: "local" }])
    : undefined;

  useEffect(() => {
    if (!desktopApi?.getNavigationQueueProjection || !composerDraftStore) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let dirty = false;
    const baselines = new Map<string, NavigationQueueProjection>();

    const refresh = async (): Promise<void> => {
      if (running) { dirty = true; return; }
      running = true;
      try {
        const demands = new Map<string, ComposerThreadOwner>();
        for (const scope of composerDraftStore.getQueuedScopeKeys()) {
          const resolved = resolveComposerScopeOwner(composerDraftStore, scope);
          if (resolved.state === "known") demands.set(scope, resolved.owner);
        }
        const selected = current.current.selectedThread;
        if (selected) demands.set(buildThreadComposerScopeKey(selected.source, selected.id), {
          backend: selected.source,
          threadId: selected.id,
          target: selected.federation?.ref.target ?? current.current.federationTarget ?? { scope: "local" },
        });
        const pending = [...demands];
        await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
          while (!cancelled) {
            const demand = pending.shift();
            if (!demand) return;
            const [scope, owner] = demand;
            const baselineKey = JSON.stringify(owner);
            const atReadStart = composerDraftStore.getQueuedTurns(scope);
            try {
              const projection = await readCompleteNavigationQueue({
                owner,
                read: desktopApi.getNavigationQueueProjection!,
                previous: baselines.get(baselineKey),
                isCancelled: () => cancelled,
              });
              if (cancelled) return;
              baselines.set(baselineKey, projection);
              const existing = composerDraftStore.getQueuedTurns(scope);
              const next = reconcileCompleteNavigationQueue({
                owner, projection, atReadStart, current: existing,
              });
              if (JSON.stringify(next) !== JSON.stringify(existing)) composerDraftStore.setQueuedTurns(scope, next);
            } catch {
              // A failed or partial read is never evidence that a FIFO is empty.
            }
          }
        }));
        const owners = new Set([...demands.values()].map((owner) => JSON.stringify(owner)));
        for (const key of baselines.keys()) if (!owners.has(key)) baselines.delete(key);
      } finally {
        running = false;
        if (dirty && !cancelled) { dirty = false; schedule(); }
      }
    };
    const schedule = (): void => {
      if (timer !== undefined || cancelled) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
    };
    const unsubscribeQueue = composerDraftStore.subscribeQueuedTurns(schedule);
    const unsubscribeEvents = desktopApi.onAgentEvent?.((event) => {
      const method = event.notification.method;
      if (method.startsWith("turn/") || method.startsWith("thread/queued")
        || method === "thread/turnQueue/updated"
        || method.startsWith("thread/executionMode/") || method === "thread/status/changed") schedule();
    });
    void refresh();
    // Independent queue ownership survives hidden navigation demand.
    const interval = setInterval(schedule, 60_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(interval);
      unsubscribeQueue();
      unsubscribeEvents?.();
    };
  }, [composerDraftStore, desktopApi, selectedKey]);
}
