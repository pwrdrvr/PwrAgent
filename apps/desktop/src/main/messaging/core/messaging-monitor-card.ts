import { buildThreadIdentityKey, shortenDerivedThreadTitle } from "@pwragent/shared";
import type {
  NavigationDirectorySummary,
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type {
  MessagingActiveTurnSummary,
  MessagingBindingRecord,
  MessagingCapabilityProfile,
  MessagingStatusIntent,
  MessagingSurfaceAction,
} from "@pwragent/messaging-interface";
import {
  applyActionCapabilityLimits,
  capabilityProfileSupportsActionCount,
} from "@pwragent/messaging-interface";

export const MESSAGING_MONITOR_INTERVAL_MS = 60_000;
export const MESSAGING_MONITOR_THREAD_LIMIT = 5;

const MONITOR_MIN_ACTIONS = 1;

export function buildMonitorStatusIntent(params: {
  activeTurnsByThreadKey?: ReadonlyMap<string, MessagingActiveTurnSummary>;
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  navigation: NavigationSnapshot;
  threadLimit?: number;
}): MessagingStatusIntent {
  const threadLimit = Math.max(1, params.threadLimit ?? MESSAGING_MONITOR_THREAD_LIMIT);
  const threads = params.navigation.threads.slice(0, threadLimit);
  const activeTurns = params.activeTurnsByThreadKey ?? new Map();
  const hasWorkingThread = threads.some((thread) => {
    const turn = activeTurns.get(buildThreadIdentityKey(thread.source, thread.id));
    return turn?.status === "working" || turn?.status === "waiting";
  });
  const lines =
    threads.length > 0
      ? threads.map((thread, index) =>
          formatThreadLine({
            index,
            navigation: params.navigation,
            now: params.createdAt,
            thread,
            turn: activeTurns.get(buildThreadIdentityKey(thread.source, thread.id)),
          }),
        )
      : ["No recent threads."];
  const canUpdateSurface = Boolean(
    params.binding.monitorSurface &&
      params.capabilityProfile?.text.supportsMessageEdit !== false,
  );

  return {
    id: params.id,
    kind: "status",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: {
      mode: canUpdateSurface ? "update" : "present",
      fallback: "present_new",
    },
    targetSurface: canUpdateSurface ? params.binding.monitorSurface : undefined,
    status: hasWorkingThread ? "working" : "idle",
    text: [
      "Monitor: Recent threads",
      `Updated: ${formatTimeOfDay(params.createdAt)}`,
      `Interval: ${formatInterval(params.binding.monitor?.intervalMs ?? MESSAGING_MONITOR_INTERVAL_MS)}`,
      "",
      ...lines,
    ].join("\n"),
    actions: buildMonitorActions(params.capabilityProfile),
  };
}

function buildMonitorActions(
  profile?: MessagingCapabilityProfile,
): MessagingSurfaceAction[] {
  if (profile && !capabilityProfileSupportsActionCount(profile, MONITOR_MIN_ACTIONS)) {
    return [];
  }

  return applyActionCapabilityLimits(
    [
      {
        id: "monitor:stop",
        label: "Stop Monitor",
        style: "danger",
        fallbackText: "monitor stop",
        priority: 1,
      },
      {
        id: "monitor:refresh",
        label: "Refresh",
        style: "secondary",
        fallbackText: "monitor refresh",
        priority: 2,
      },
    ],
    profile,
  );
}

function formatThreadLine(params: {
  index: number;
  navigation: NavigationSnapshot;
  now: number;
  thread: NavigationThreadSummary;
  turn?: MessagingActiveTurnSummary;
}): string {
  const title = formatThreadTitle(params.thread);
  const directory = projectLabelForThread(params.navigation, params.thread);
  const state = formatThreadState(params.thread, params.turn);
  const updated = formatRelativeTime(params.thread.updatedAt, params.now);
  const directorySuffix = directory ? ` - ${directory}` : "";
  return `${params.index + 1}. ${title} (${params.thread.source}) - ${state} - ${updated}${directorySuffix}`;
}

function formatThreadTitle(thread: NavigationThreadSummary): string {
  const title = (thread.titleSource === "derived"
    ? shortenDerivedThreadTitle(thread.title ?? "")
    : thread.title) ?? "";
  const trimmed = title.trim();
  if (trimmed.length > 0) {
    return trimmed.length > 64 ? `${trimmed.slice(0, 61)}...` : trimmed;
  }
  return thread.id.length > 28 ? `${thread.id.slice(0, 25)}...` : thread.id;
}

function projectLabelForThread(
  navigation: NavigationSnapshot,
  thread: NavigationThreadSummary,
): string | undefined {
  const linked =
    thread.linkedDirectories.find((candidate) => candidate.kind === "worktree") ??
    thread.linkedDirectories.find((candidate) => candidate.kind === "local") ??
    thread.linkedDirectories[0];
  if (linked?.label) {
    return linked.label;
  }
  const threadKey = buildThreadIdentityKey(thread.source, thread.id);
  return navigation.directories.find((directory: NavigationDirectorySummary) =>
    directory.threadKeys.includes(threadKey),
  )?.label;
}

function formatThreadState(
  thread: NavigationThreadSummary,
  turn: MessagingActiveTurnSummary | undefined,
): string {
  if (turn?.status === "working") {
    return "working";
  }
  if (turn?.status === "waiting") {
    return "waiting";
  }
  if (thread.queuedExecutionMode) {
    return "queued permissions";
  }
  return "idle";
}

function formatRelativeTime(epochMs: number | undefined, now: number): string {
  if (!epochMs) {
    return "updated unknown";
  }
  const elapsedMs = Math.max(0, now - epochMs);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) {
    return "updated just now";
  }
  if (elapsedMinutes < 60) {
    return `updated ${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `updated ${elapsedHours}h ago`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `updated ${elapsedDays}d ago`;
}

function formatTimeOfDay(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHours}:${minutes.toString().padStart(2, "0")} ${period}`;
}

function formatInterval(intervalMs: number): string {
  const minutes = Math.max(1, Math.round(intervalMs / 60_000));
  return `${minutes} min`;
}
