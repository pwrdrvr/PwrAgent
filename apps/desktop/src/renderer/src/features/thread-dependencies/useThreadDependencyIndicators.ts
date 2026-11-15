import { createContext, useContext, useEffect, useState } from "react";
import type { AppServerBackendKind, FederationTarget, NavigationThreadSummary, ThreadDependency } from "@pwragent/shared";
import { buildThreadIdentityKey, THREAD_DEPENDENCY_CONDITION_PHRASES, threadDependencyDeliveryTarget } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import {
  ACTIVE_DEPENDENCY_STATUSES,
  evidenceFor,
  groupDeliveryReviews,
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
  /** Bounded preview; Continue After contains the full registrations. */
  tooltip: string;
  /** A waiting registration holds this thread's merges. */
  mergeHeld: boolean;
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
const MAX_TOOLTIP_REGISTRATIONS = 2;
const MAX_TOOLTIP_CONDITIONS = 3;
const MAX_TOOLTIP_REVIEW_GROUPS = 3;
const MAX_TOOLTIP_CAUSE_LENGTH = 120;

/**
 * The key a thread's indicator is filed under: its owner as this window
 * names it (none for this machine), then the thread.
 */
export function threadDependencyIndicatorKey(backend: AppServerBackendKind, threadId: string, instanceId?: string): string {
  return instanceId ? `${instanceId}:${buildThreadIdentityKey(backend, threadId)}` : buildThreadIdentityKey(backend, threadId);
}

/** A thread's indicator. A peer's row reads the waits its owner keeps. */
export function readThreadDependencyIndicator(
  context: Pick<ThreadDependencyIndicatorsValue, "byThreadKey"> | undefined,
  thread: Pick<NavigationThreadSummary, "id" | "source" | "federation">,
): ThreadDependencyIndicator | undefined {
  if (!context) return undefined;
  const target = thread.federation?.ref.target;
  const instanceId = target?.scope === "remote" ? target.instanceId : undefined;
  const indicator = context.byThreadKey.get(threadDependencyIndicatorKey(thread.source, thread.id, instanceId));
  if (indicator || !instanceId) return indicator;
  // A remote window's list comes from the instance it fronts, unqualified.
  const windowTarget = readRendererFederationTarget();
  return windowTarget?.scope === "remote" && windowTarget.instanceId === instanceId
    ? context.byThreadKey.get(threadDependencyIndicatorKey(thread.source, thread.id))
    : undefined;
}

export function useThreadDependencyIndicator(
  thread: Pick<NavigationThreadSummary, "id" | "source" | "federation">,
): ThreadDependencyIndicator | undefined {
  return readThreadDependencyIndicator(useContext(ThreadDependencyIndicatorsContext), thread);
}

export function useThreadDependencyIndicatorsContext(): ThreadDependencyIndicatorsValue | undefined {
  return useContext(ThreadDependencyIndicatorsContext);
}

/**
 * Lists the active registrations of this instance and its connected peers,
 * and refreshes on every `thread/dependencies/updated` event. In a remote
 * window, main asks that window's instance. A failed refresh keeps the last
 * list: a row losing its chip would read as the wait having ended.
 */
export function useThreadDependencyIndicators(desktopApi?: DesktopApi): ReadonlyMap<string, ThreadDependencyIndicator> {
  const [indicators, setIndicators] = useState(EMPTY);
  useEffect(() => {
    if (!desktopApi?.manageThreadDependencies) {
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
        const next = summarizeThreadDependencies(response.dependencies, response.peerActive);
        // Rows read this through context; an equal list keeps its identity so
        // an update that changes no chip re-renders no row.
        setIndicators((current) => sameIndicators(current, next) ? current : next);
      } catch {
        // Keep the last list; the next update event retries.
      }
    };
    void refresh();
    const unsubscribe = desktopApi.onAgentEvent?.((event) => {
      if (event.notification.method !== "thread/dependencies/updated") return;
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
  peerActive: readonly { dependency: ThreadDependency; owner: FederationTarget }[] = [],
): ReadonlyMap<string, ThreadDependencyIndicator> {
  const byThread = new Map<string, ThreadDependency[]>();
  const entries = [
    ...dependencies.map((dependency) => ({ dependency, instanceId: undefined as string | undefined })),
    ...peerActive.map(({ dependency, owner }) => ({ dependency, instanceId: owner.scope === "remote" ? owner.instanceId : undefined })),
  ];
  for (const { dependency, instanceId } of entries) {
    if (!ACTIVE_DEPENDENCY_STATUSES.has(dependency.status)) continue;
    const key = threadDependencyIndicatorKey(dependency.backend, dependency.threadId, instanceId);
    const items = byThread.get(key);
    if (items) items.push(dependency);
    else byThread.set(key, [dependency]);
  }
  const indicators = new Map<string, ThreadDependencyIndicator>();
  for (const [key, items] of byThread) {
    items.sort((left, right) => left.createdAt - right.createdAt);
    const reviewCount = items.filter(needsDeliveryReview).length;
    const alert = reviewCount > 0;
    const mergeHeld = items.some(holdsMerge);
    indicators.set(key, {
      count: items.length,
      alert,
      mergeHeld,
      label: alert ? `Check delivery${reviewCount > 1 ? ` · ${reviewCount}` : ""}` : mergeHeld ? "Merge held" : items.length > 1 ? `${items.length} waiting` : progressLabel(items[0]!),
      tooltip: describeRegistrations(items, reviewCount),
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
    if (!other || other.count !== indicator.count || other.alert !== indicator.alert || other.mergeHeld !== indicator.mergeHeld
      || other.label !== indicator.label || other.tooltip !== indicator.tooltip) return false;
  }
  return true;
}

const holdsMerge = (dependency: ThreadDependency): boolean =>
  Boolean(dependency.holdMerge) && (dependency.status === "waiting" || dependency.status === "ready");

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

function describeRegistrations(items: ThreadDependency[], reviewCount: number): string {
  if (reviewCount) return describeReviews(items, reviewCount);
  const preview = items.slice(0, MAX_TOOLTIP_REGISTRATIONS);
  const lines: string[] = [];
  if (items.length > 1) lines.push(`${items.length} active waits.`);
  lines.push(...preview.map((item) => describeRegistration(item, items.length > 1)));
  if (items.length > preview.length) lines.push(`+${items.length - preview.length} more registrations. Open Continue After for the full list.`);
  return lines.join("\n\n");
}

/**
 * Uncertain deliveries come first and say why: one clipped line per distinct
 * error. Their registrations look alike, so none is previewed; the dialog
 * lists each one with its full error.
 */
function describeReviews(items: ThreadDependency[], reviewCount: number): string {
  const groups = groupDeliveryReviews(items);
  const causes = groups.slice(0, MAX_TOOLTIP_REVIEW_GROUPS).map(({ cause, items: group }) =>
    `${group.length} × ${clip(cause, MAX_TOOLTIP_CAUSE_LENGTH)}`);
  if (groups.length > MAX_TOOLTIP_REVIEW_GROUPS) {
    const rest = groups.slice(MAX_TOOLTIP_REVIEW_GROUPS).reduce((total, group) => total + group.items.length, 0);
    causes.push(`+${rest} more with ${groups.length - MAX_TOOLTIP_REVIEW_GROUPS} other ${groups.length - MAX_TOOLTIP_REVIEW_GROUPS === 1 ? "error" : "errors"}`);
  }
  return [
    `${items.length > reviewCount ? `${items.length} active waits · ${reviewCount} need delivery review` : reviewCount === 1 ? "1 delivery needs review" : `${reviewCount} deliveries need review`}.\nA continuation may have started, but delivery was not confirmed.`,
    causes.join("\n"),
    reviewCount === 1 ? "Open Continue After to review it." : "Open Continue After to review them together.",
  ].join("\n\n");
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function describeRegistration(dependency: ThreadDependency, identify: boolean): string {
  const heading = dependency.conditions.length > 1
    ? `Continue after ${dependency.mode === "any" ? "any" : "all"} of:`
    : "Continue after:";
  const lines = dependency.conditions.slice(0, MAX_TOOLTIP_CONDITIONS).map((condition, index) => {
    const state = evidenceFor(dependency, index)?.state;
    const mark = state === "satisfied" ? "✓" : state === "failed" ? "✗" : "○";
    const name = condition.subject?.trim() || condition.title || condition.threadId;
    return `${mark} ${name.length > 80 ? `${name.slice(0, 79)}…` : name} ${THREAD_DEPENDENCY_CONDITION_PHRASES[condition.when]}`;
  });
  if (dependency.conditions.length > MAX_TOOLTIP_CONDITIONS) lines.push(`+${dependency.conditions.length - MAX_TOOLTIP_CONDITIONS} more prerequisites. Open Continue After for details.`);
  if (holdsMerge(dependency)) lines.push("Merging waits.");
  if (threadDependencyDeliveryTarget(dependency) === "operator") lines.push("Then reminds you.");
  if (needsDeliveryReview(dependency)) lines.push("Delivery needs review.");
  return [identify ? `Registration ${dependency.id.slice(0, 8)}` : undefined, heading, ...lines].filter(Boolean).join("\n");
}
