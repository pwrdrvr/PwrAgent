import { createContext, useContext, useEffect, useState } from "react";
import type { NavigationThreadSummary, ThreadDependency } from "@pwragent/shared";
import { buildThreadIdentityKey, THREAD_DEPENDENCY_CONDITION_PHRASES, threadDependencyDeliveryTarget } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import {
  ACTIVE_DEPENDENCY_STATUSES,
  evidenceFor,
  isFailureReport,
  isRepairWait,
  needsDeliveryReview,
} from "./dependency-labels";

/** What a sidebar row shows for a thread with active Continue After registrations. */
export type ThreadDependencyIndicator = {
  /** Active registrations on this thread. */
  count: number;
  /** Short chip text: progress for one registration, a count for several. */
  label: string;
  /** A delivery needs the operator's review before anything else happens. */
  alert: boolean;
  /** Every prerequisite with its state, one per line. */
  tooltip: string;
};

export type ThreadDependencyIndicatorsValue = {
  byThreadKey: ReadonlyMap<string, ThreadDependencyIndicator>;
  /** Opens Continue After for a thread. Absent where no dialog can open. */
  open?: (thread: NavigationThreadSummary) => void;
};

export const ThreadDependencyIndicatorsContext = createContext<ThreadDependencyIndicatorsValue | undefined>(undefined);

const EMPTY: ReadonlyMap<string, ThreadDependencyIndicator> = new Map();
// Evaluation publishes one update per changed registration; a PR poll can
// change several at once, so a burst becomes one list request.
const REFRESH_DEBOUNCE_MS = 150;

/** A local thread's indicator. Dependencies run on the owning machine, so a peer's row has none. */
export function useThreadDependencyIndicator(
  thread: Pick<NavigationThreadSummary, "id" | "source" | "federation">,
): ThreadDependencyIndicator | undefined {
  const context = useContext(ThreadDependencyIndicatorsContext);
  if (!context || thread.federation) return undefined;
  return context.byThreadKey.get(buildThreadIdentityKey(thread.source, thread.id));
}

export function useThreadDependencyIndicatorsContext(): ThreadDependencyIndicatorsValue | undefined {
  return useContext(ThreadDependencyIndicatorsContext);
}

/**
 * Lists this instance's active registrations and refreshes on every
 * `thread/dependencies/updated` event. A failed refresh keeps the last list:
 * a row losing its chip would read as the wait having ended.
 */
export function useThreadDependencyIndicators(desktopApi?: DesktopApi): ReadonlyMap<string, ThreadDependencyIndicator> {
  const [indicators, setIndicators] = useState(EMPTY);
  useEffect(() => {
    if (!desktopApi?.manageThreadDependencies || readRendererFederationTarget()?.scope === "remote") {
      setIndicators(EMPTY);
      return;
    }
    let disposed = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const sequence = ++latest;
      try {
        const response = await desktopApi.manageThreadDependencies!({ action: "active" });
        if (disposed || sequence !== latest) return;
        const next = summarizeThreadDependencies(response.dependencies);
        // Rows read this through context; an equal list keeps its identity so
        // an update that changes no chip re-renders no row.
        setIndicators((current) => sameIndicators(current, next) ? current : next);
      } catch {
        // Keep the last list; the next update event retries.
      }
    };
    void refresh();
    const unsubscribe = desktopApi.onAgentEvent?.((event) => {
      if (event.federationTarget?.scope === "remote" || event.notification.method !== "thread/dependencies/updated") return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [desktopApi]);
  return indicators;
}

export function summarizeThreadDependencies(
  dependencies: readonly ThreadDependency[],
): ReadonlyMap<string, ThreadDependencyIndicator> {
  const byThread = new Map<string, ThreadDependency[]>();
  for (const dependency of dependencies) {
    if (!ACTIVE_DEPENDENCY_STATUSES.has(dependency.status)) continue;
    const key = buildThreadIdentityKey(dependency.backend, dependency.threadId);
    const items = byThread.get(key);
    if (items) items.push(dependency);
    else byThread.set(key, [dependency]);
  }
  const indicators = new Map<string, ThreadDependencyIndicator>();
  for (const [key, items] of byThread) {
    items.sort((left, right) => left.createdAt - right.createdAt);
    const alert = items.some(needsDeliveryReview);
    indicators.set(key, {
      count: items.length,
      alert,
      label: alert ? "Check delivery" : items.length > 1 ? `${items.length} waiting` : progressLabel(items[0]!),
      tooltip: items.map(describeRegistration).join("\n\n"),
    });
  }
  return indicators;
}

function sameIndicators(
  left: ReadonlyMap<string, ThreadDependencyIndicator>,
  right: ReadonlyMap<string, ThreadDependencyIndicator>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, indicator] of right) {
    const other = left.get(key);
    if (!other || other.count !== indicator.count || other.alert !== indicator.alert
      || other.label !== indicator.label || other.tooltip !== indicator.tooltip) return false;
  }
  return true;
}

function progressLabel(dependency: ThreadDependency): string {
  if (dependency.status === "ready") {
    return isRepairWait(dependency) ? "CI repair" : isFailureReport(dependency) ? "Failed" : "Ready";
  }
  if (dependency.status === "dispatching") return "Continuing";
  const total = dependency.conditions.length;
  if (total < 2) return "Waiting";
  if (dependency.mode === "any") return `Any of ${total}`;
  const met = dependency.conditions.filter((_, index) => evidenceFor(dependency, index)?.state === "satisfied").length;
  return `${met} of ${total}`;
}

function describeRegistration(dependency: ThreadDependency): string {
  const heading = dependency.conditions.length > 1
    ? `Continue after ${dependency.mode === "any" ? "any" : "all"} of:`
    : "Continue after:";
  const lines = dependency.conditions.map((condition, index) => {
    const state = evidenceFor(dependency, index)?.state;
    const mark = state === "satisfied" ? "✓" : state === "failed" ? "✗" : "○";
    return `${mark} ${condition.title || condition.threadId} ${THREAD_DEPENDENCY_CONDITION_PHRASES[condition.when]}`;
  });
  if (threadDependencyDeliveryTarget(dependency) === "operator") lines.push("Then reminds you.");
  if (needsDeliveryReview(dependency)) lines.push("Delivery needs review.");
  return [heading, ...lines].join("\n");
}
