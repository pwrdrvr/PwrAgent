import { useCallback, useSyncExternalStore } from "react";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerNotification } from "@pwragent/shared/contracts/normalized-app-server";
import { applySubAgentActivityChanges } from "@pwragent/shared/sub-agent-activity-lines";
import { splitGraphemes } from "@pwragent/shared/text-graphemes";
import type { DesktopApi } from "./desktop-api";
import { agentEventThreadIdentityKey } from "./federated-thread-events";
import { readRendererFederationTarget } from "./federation-window";

/** A thread's running sub-agents' current activity lines, by card `monitorId`. */
export type SubAgentActivities = ReadonlyMap<string, string>;

type ActivityParams = Extract<AppServerNotification, { method: "thread/subAgentActivity/updated" }>["params"];

const EMPTY: SubAgentActivities = new Map();

/**
 * What each running sub-agent is doing now, by thread identity key, merged
 * from the events' changes. Live only, the same as the event it comes from: a
 * window that opens mid-run shows the line from the sub-agent's next tool
 * call on, and a row shows a line only while its card runs.
 */
const activitiesByThread = new Map<string, SubAgentActivities>();
const listeners = new Set<() => void>();
let subscribedApi: DesktopApi | undefined;
let unsubscribe: (() => void) | undefined;

/** Applies one event; true when the store changed. Exported for tests. */
export function applySubAgentActivityEvent(event: AgentEvent): boolean {
  if (event.notification.method !== "thread/subAgentActivity/updated") return false;
  const params = event.notification.params as ActivityParams;
  // A viewer window's rows are all the peer's, keyed remote, and its events
  // need not say so: key them by the window's target, as the rows are.
  const key = agentEventThreadIdentityKey({
    ...event,
    federationTarget: event.federationTarget ?? readRendererFederationTarget(),
  }, params.threadId);
  const previous = activitiesByThread.get(key) ?? EMPTY;
  const next = applySubAgentActivityChanges(previous, params);
  if (next === previous) return false;
  if (next.size === 0) activitiesByThread.delete(key);
  else activitiesByThread.set(key, next);
  return true;
}

/** Test seam: forget every activity line and the event subscription. */
export function resetSubAgentActivityStore(): void {
  activitiesByThread.clear();
  listeners.clear();
  unsubscribe?.();
  unsubscribe = undefined;
  subscribedApi = undefined;
}

function ensureSubscribed(desktopApi: DesktopApi): void {
  // One subscription for the window's lifetime: a tray that mounts later
  // still sees lines published while no tray was open.
  if (subscribedApi === desktopApi || !desktopApi.onAgentEvent) return;
  unsubscribe?.();
  subscribedApi = desktopApi;
  unsubscribe = desktopApi.onAgentEvent((event) => {
    if (!applySubAgentActivityEvent(event)) return;
    for (const listener of listeners) listener();
  });
}

/** The activity lines for one thread, by `monitorId`; empty when none run. */
export function useSubAgentActivities(
  desktopApi: DesktopApi | undefined,
  threadKey: string | undefined,
): SubAgentActivities {
  const subscribe = useCallback((listener: () => void) => {
    if (desktopApi) ensureSubscribed(desktopApi);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [desktopApi]);
  const snapshot = useCallback(
    () => (threadKey ? activitiesByThread.get(threadKey) : undefined) ?? EMPTY,
    [threadKey],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Trailing characters kept whole when an activity line names a path. */
export const SUB_AGENT_ACTIVITY_TAIL_CHARS = 18;

/**
 * Splits a line for middle truncation when it names a path: "Running cd
 * /Users/…/docs.pwragent.ai && grep -n foo" keeps the command's end and
 * "Reading …/styles/app.css" keeps the file. Other lines end-truncate.
 * The cut falls between grapheme clusters, as `splitPrBranch` explains.
 */
export function splitSubAgentActivity(line: string): { head: string; tail: string } {
  if (!line.includes("/")) return { head: line, tail: "" };
  const clusters = splitGraphemes(line);
  const tailLength = Math.min(SUB_AGENT_ACTIVITY_TAIL_CHARS, Math.floor(clusters.length / 2));
  return {
    head: clusters.slice(0, clusters.length - tailLength).join(""),
    tail: clusters.slice(clusters.length - tailLength).join(""),
  };
}
