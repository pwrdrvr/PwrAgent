import { buildOwnedComposerScopeKey } from "@pwragent/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComposerThreadOwner,
  FederationTarget,
  FederationEventSubscription,
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
import { navigationQueueBaselineBudget } from "./navigation-metadata-budget";

let nextQueueConsumer = 0;

export type SelectedQueueReadiness = {
  ownerKey?: string;
  readiness: "loading" | "ready" | "failed";
  projection?: NavigationQueueProjection;
  error?: string;
};

/** Complete FIFO reads follow local scope identities, independently of navigation pages. */
export function useIndependentQueueProjection(params: {
  composerDraftStore?: ComposerDraftStore;
  desktopApi?: DesktopApi;
  selectedThread?: NavigationThreadSummary;
  federationTarget?: FederationTarget;
}): SelectedQueueReadiness & { refresh: () => Promise<void> } {
  const { desktopApi, composerDraftStore } = params;
  const current = useRef(params);
  current.current = params;
  const selected = params.selectedThread;
  const selectedOwner: ComposerThreadOwner | undefined = selected ? {
    backend: selected.source,
    threadId: selected.id,
    target: selected.federation?.ref.target ?? params.federationTarget ?? { scope: "local" },
  } : undefined;
  const selectedKey = selectedOwner ? buildOwnedComposerScopeKey(selectedOwner) : undefined;
  const [selectedState, setSelectedState] = useState<SelectedQueueReadiness>({ readiness: "loading" });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refreshSelected = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    if (!desktopApi?.getNavigationQueueProjection) {
      setSelectedState({ ownerKey: selectedKey, readiness: "failed",
        error: "Desktop bridge is missing independent queue support. Upgrade this instance." });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let dirty = false;
    const subscriptionId = String(++nextQueueConsumer);
    const baselines = new Map<string, NavigationQueueProjection>();
    const budgetKeys = new Set<string>();
    const consumers = new Set<string>();
    const demandedInstances = new Set<string>();
    const peerStatuses = new Map<string, string>();
    let subscriptions: FederationEventSubscription[] = [];
    let subscriptionsJson = "";
    const publishSubscriptions = (): void => {
      void desktopApi.setFederationEventSubscriptions?.({
        consumer: "queue_projection", consumerInstanceId: subscriptionId, subscriptions,
      }).catch(() => {});
    };

    const refresh = async (): Promise<void> => {
      if (running) { dirty = true; return; }
      running = true;
      try {
        const demands = new Map<string, { owner: ComposerThreadOwner; scopes: Set<string> }>();
        for (const scope of composerDraftStore?.getQueuedScopeKeys() ?? []) {
          const resolved = resolveComposerScopeOwner(composerDraftStore!, scope);
          if (resolved.state !== "known") continue;
          const key = buildOwnedComposerScopeKey(resolved.owner);
          const demand = demands.get(key) ?? { owner: resolved.owner, scopes: new Set<string>() };
          demand.scopes.add(scope);
          demands.set(key, demand);
          if (demands.size > 256) throw new Error("Queue scope admission exceeds 256 owners; existing replies were retained.");
        }
        const selected = current.current.selectedThread;
        if (selected) {
          const owner: ComposerThreadOwner = {
            backend: selected.source, threadId: selected.id,
            target: selected.federation?.ref.target ?? current.current.federationTarget ?? { scope: "local" },
          };
          const key = buildOwnedComposerScopeKey(owner);
          const demand = demands.get(key) ?? { owner, scopes: new Set<string>() };
          const scope = buildThreadComposerScopeKey(selected.source, selected.id, owner.target);
          const resolved = composerDraftStore ? resolveComposerScopeOwner(composerDraftStore, scope) : undefined;
          // Selection authorizes an exact read, never ownership of ambiguous or legacy local drafts.
          if (resolved?.state === "known" && buildOwnedComposerScopeKey(resolved.owner) === key) demand.scopes.add(scope);
          demands.set(key, demand);
        }
        demandedInstances.clear();
        for (const { owner } of demands.values()) {
          if (owner.target.scope === "remote") demandedInstances.add(owner.target.instanceId);
        }
        for (const instanceId of peerStatuses.keys()) if (!demandedInstances.has(instanceId)) peerStatuses.delete(instanceId);
        const refsByOwner = new Map<string, Array<{ backend: ComposerThreadOwner["backend"]; threadId: string }>>();
        for (const { owner } of demands.values()) {
          if (owner.target.scope !== "remote") continue;
          const refs = refsByOwner.get(owner.target.instanceId) ?? [];
          refs.push({ backend: owner.backend, threadId: owner.threadId });
          refsByOwner.set(owner.target.instanceId, refs);
        }
        subscriptions = [...refsByOwner].map(([sourceInstanceId, threads]) => ({
          sourceInstanceId, eventClasses: ["navigation"], threadSelection: { kind: "threads", threads },
        }));
        const nextSubscriptionsJson = JSON.stringify(subscriptions);
        if (subscriptionsJson !== nextSubscriptionsJson) {
          subscriptionsJson = nextSubscriptionsJson;
          publishSubscriptions();
        }
        const pending = [...demands];
        await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
          while (!cancelled) {
            const demand = pending.shift();
            if (!demand) return;
            const [baselineKey, { owner, scopes }] = demand;
            const captured = new Map([...scopes].map((scope) => [scope, composerDraftStore!.getQueuedTurns(scope)]));
            const consumerId = `queue-projection:${++nextQueueConsumer}`;
            consumers.add(consumerId);
            const budgetKey = `queue:${subscriptionId}:${baselineKey}`;
            let allocation: ReturnType<typeof navigationQueueBaselineBudget.begin> | undefined;
            try {
              allocation = navigationQueueBaselineBudget.begin(budgetKey);
              budgetKeys.add(budgetKey);
              const projection = await readCompleteNavigationQueue({
                owner,
                read: (request) => desktopApi.getNavigationQueueProjection!(request, consumerId),
                previous: baselines.get(baselineKey),
                isCancelled: () => cancelled,
                allocation,
              });
              if (cancelled) return;
              if (projection !== baselines.get(baselineKey)) allocation.commit();
              baselines.set(baselineKey, projection);
              if (baselineKey === selectedKey) setSelectedState({ ownerKey: baselineKey, readiness: "ready", projection });
              for (const [scope, atReadStart] of captured) {
                const resolved = resolveComposerScopeOwner(composerDraftStore!, scope);
                if (resolved.state !== "known" || buildOwnedComposerScopeKey(resolved.owner) !== baselineKey) continue;
                const existing = composerDraftStore!.getQueuedTurns(scope);
                const next = reconcileCompleteNavigationQueue({ owner, projection, atReadStart, current: existing });
                if (JSON.stringify(next) !== JSON.stringify(existing)) composerDraftStore!.setQueuedTurns(scope, next);
              }
            } catch (error) {
              // A failed or partial read is never evidence that a FIFO is empty.
              if (!cancelled && baselineKey === selectedKey) setSelectedState({
                ownerKey: baselineKey, readiness: "failed", projection: baselines.get(baselineKey),
                error: error instanceof Error ? error.message : String(error),
              });
            } finally {
              allocation?.dispose();
              consumers.delete(consumerId);
              void desktopApi.releaseNavigationQuery?.(consumerId).catch(() => {});
            }
          }
        }));
        const owners = new Set(demands.keys());
        for (const key of baselines.keys()) if (!owners.has(key)) {
          baselines.delete(key);
          const budgetKey = `queue:${subscriptionId}:${key}`;
          navigationQueueBaselineBudget.release(budgetKey);
          budgetKeys.delete(budgetKey);
        }
      } catch (error) {
        if (!cancelled) setSelectedState((previous) => ({
          ...previous, ownerKey: selectedKey, readiness: "failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        running = false;
        if (dirty && !cancelled) { dirty = false; schedule(); }
      }
    };
    const schedule = (): void => {
      if (timer !== undefined || cancelled) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
    };
    refreshRef.current = refresh;
    const unsubscribeQueue = composerDraftStore?.subscribeQueuedTurns(schedule);
    const unsubscribeEvents = desktopApi.onAgentEvent?.((event) => {
      const method = event.notification.method === "navigation/invalidated"
        && typeof event.notification.params.sourceMethod === "string"
        ? event.notification.params.sourceMethod : event.notification.method;
      if (method === "federation/peerStatus/changed") {
        const peer = event.notification.params as { instanceId: string; status: string };
        if (!demandedInstances.has(peer.instanceId) || peerStatuses.get(peer.instanceId) === peer.status) return;
        peerStatuses.set(peer.instanceId, peer.status);
        if (peer.status === "connected") { publishSubscriptions(); schedule(); }
        return;
      }
      if (method.startsWith("turn/") || method.startsWith("thread/queued")
        || method === "thread/turnQueue/updated"
        || method.startsWith("thread/executionMode/") || method === "thread/status/changed") schedule();
    });
    void refresh();
    // Independent queue ownership survives hidden navigation demand.
    const interval = setInterval(schedule, 60_000);
    return () => {
      cancelled = true;
      subscriptions = [];
      publishSubscriptions();
      for (const key of budgetKeys) navigationQueueBaselineBudget.release(key);
      budgetKeys.clear();
      for (const consumerId of consumers) void desktopApi.releaseNavigationQuery?.(consumerId).catch(() => {});
      consumers.clear();
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(interval);
      refreshRef.current = async () => {};
      unsubscribeQueue?.();
      unsubscribeEvents?.();
    };
  }, [composerDraftStore, desktopApi, selectedKey]);
  return {
    ...(selectedState.ownerKey === selectedKey ? selectedState : { ownerKey: selectedKey, readiness: "loading" as const }),
    refresh: refreshSelected,
  };
}
