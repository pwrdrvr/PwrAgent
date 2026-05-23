import {
  buildThreadIdentityKey,
  comparePinnedThreads,
  isPinnedThread,
  shortenDerivedThreadTitle,
} from "@pwragent/shared";
import type {
  NavigationDirectorySummary,
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type {
  MessagingActiveTurnSummary,
  MessagingBindingRecord,
  MessagingCapabilityProfile,
  MessagingMonitorState,
  MessagingStatusIntent,
  MessagingSurfaceAction,
  MessagingSurfaceRef,
} from "@pwragent/messaging-interface";
import {
  applyActionCapabilityLimits,
  capabilityProfileSupportsActionCount,
} from "@pwragent/messaging-interface";

export const MESSAGING_MONITOR_INTERVAL_MS = 60_000;
export const MESSAGING_MONITOR_INTERVAL_OPTIONS_MS = [
  10_000,
  30_000,
  60_000,
  5 * 60_000,
] as const;
export const MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT = 5;
export const MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT = 5;
export const MESSAGING_MONITOR_THREAD_LIMIT =
  MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT;
export const MESSAGING_MONITOR_THREAD_LIMIT_OPTIONS = [0, 5, 10] as const;
export const MESSAGING_MONITOR_SNIPPET_LENGTH = 100;

const MONITOR_MIN_ACTIONS = 1;

export type MessagingMonitorThreadSelection = {
  pinnedThreadLimit: number;
  pinnedThreads: NavigationThreadSummary[];
  recentThreadLimit: number;
  recentThreads: NavigationThreadSummary[];
  threads: NavigationThreadSummary[];
};

export function buildMonitorStatusIntent(params: {
  activeTurnsByThreadKey?: ReadonlyMap<string, MessagingActiveTurnSummary>;
  binding?: MessagingBindingRecord;
  bindingId?: string;
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  monitor?: MessagingMonitorState;
  monitorSurface?: MessagingSurfaceRef;
  navigation: NavigationSnapshot;
  snippetsByThreadKey?: ReadonlyMap<string, string>;
  threadLimit?: number;
  topicControls?: boolean;
}): MessagingStatusIntent {
  const monitor = params.binding?.monitor ?? params.monitor;
  const monitorSurface = params.binding?.monitorSurface ?? params.monitorSurface;
  const selection = selectMonitorThreads({
    monitor,
    navigation: params.navigation,
    threadLimit: params.threadLimit,
  });
  const threads = selection.threads;
  const activeTurns = params.activeTurnsByThreadKey ?? new Map();
  const hasWorkingThread = threads.some((thread) => {
    const turn = activeTurns.get(buildThreadIdentityKey(thread.source, thread.id));
    return turn?.status === "working" || turn?.status === "waiting";
  });
  const lines = formatMonitorThreadSections({
    activeTurns,
    navigation: params.navigation,
    now: params.createdAt,
    selection,
    showSnippets: monitor?.showLastResponseSnippet === true,
    showStatusLine: monitor?.showStatusLine === true,
    snippetsByThreadKey: params.snippetsByThreadKey ?? new Map(),
  });
  const canUpdateSurface = Boolean(
    monitorSurface &&
      params.capabilityProfile?.text.supportsMessageEdit !== false,
  );

  return {
    id: params.id,
    kind: "status",
    bindingId: params.binding?.id ?? params.bindingId,
    createdAt: params.createdAt,
    delivery: {
      mode: canUpdateSurface ? "update" : "present",
      fallback: "present_new",
    },
    targetSurface: canUpdateSurface ? monitorSurface : undefined,
    status: hasWorkingThread ? "working" : "idle",
    text: [
      "Monitor: Recent threads",
      `Updated: ${formatTimeOfDay(params.createdAt)}`,
      `Interval: ${formatInterval(monitor?.intervalMs ?? MESSAGING_MONITOR_INTERVAL_MS)}`,
      `Pins: ${selection.pinnedThreadLimit} | Recent: ${selection.recentThreadLimit}`,
      `Status: ${monitor?.showStatusLine === true ? "line" : "inline"} | Snippet: ${monitor?.showLastResponseSnippet === true ? "on" : "off"}`,
      "",
      ...lines,
    ].join("\n"),
    actions: buildMonitorActions({
      pinnedThreadLimit: selection.pinnedThreadLimit,
      intervalMs: monitor?.intervalMs ?? MESSAGING_MONITOR_INTERVAL_MS,
      profile: params.capabilityProfile,
      recentThreadLimit: selection.recentThreadLimit,
      showSnippets: monitor?.showLastResponseSnippet === true,
      showStatusLine: monitor?.showStatusLine === true,
      topicControls: params.topicControls === true,
    }),
  };
}

export function selectMonitorThreads(params: {
  monitor?: MessagingMonitorState;
  navigation: NavigationSnapshot;
  threadLimit?: number;
}): MessagingMonitorThreadSelection {
  const pinnedThreadLimit = normalizeMonitorThreadLimit(
    params.monitor?.pinnedThreadLimit,
    MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT,
  );
  const recentThreadLimit = normalizeMonitorThreadLimit(
    params.monitor?.recentThreadLimit ?? params.threadLimit,
    params.threadLimit ?? MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT,
  );
  const pinnedThreads = params.navigation.threads
    .filter(isPinnedThread)
    .sort(comparePinnedThreads)
    .slice(0, pinnedThreadLimit);
  const recentThreads = params.navigation.threads
    .filter((thread) => !isPinnedThread(thread))
    .slice(0, recentThreadLimit);

  return {
    pinnedThreadLimit,
    pinnedThreads,
    recentThreadLimit,
    recentThreads,
    threads: [...pinnedThreads, ...recentThreads],
  };
}

export function normalizeMonitorThreadLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value <= 0) {
    return 0;
  }
  if (value <= 5) {
    return 5;
  }
  return 10;
}

export function nextMonitorThreadLimit(value: number | undefined): number {
  const current = normalizeMonitorThreadLimit(value, 5);
  const index = MESSAGING_MONITOR_THREAD_LIMIT_OPTIONS.indexOf(
    current as (typeof MESSAGING_MONITOR_THREAD_LIMIT_OPTIONS)[number],
  );
  const nextIndex =
    index === -1 ? 0 : (index + 1) % MESSAGING_MONITOR_THREAD_LIMIT_OPTIONS.length;
  return MESSAGING_MONITOR_THREAD_LIMIT_OPTIONS[nextIndex];
}

export function normalizeMonitorIntervalMs(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const positive = Math.max(0, value);
  return MESSAGING_MONITOR_INTERVAL_OPTIONS_MS.reduce((nearest, option) =>
    Math.abs(option - positive) < Math.abs(nearest - positive) ? option : nearest,
  );
}

export function nextMonitorIntervalMs(value: number | undefined): number {
  const current = normalizeMonitorIntervalMs(value, MESSAGING_MONITOR_INTERVAL_MS);
  const index = MESSAGING_MONITOR_INTERVAL_OPTIONS_MS.indexOf(
    current as (typeof MESSAGING_MONITOR_INTERVAL_OPTIONS_MS)[number],
  );
  const nextIndex =
    index === -1 ? 0 : (index + 1) % MESSAGING_MONITOR_INTERVAL_OPTIONS_MS.length;
  return MESSAGING_MONITOR_INTERVAL_OPTIONS_MS[nextIndex];
}

function buildMonitorActions(params: {
  intervalMs: number;
  pinnedThreadLimit: number;
  profile?: MessagingCapabilityProfile;
  recentThreadLimit: number;
  showSnippets: boolean;
  showStatusLine: boolean;
  topicControls: boolean;
}): MessagingSurfaceAction[] {
  const { profile } = params;
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
      {
        id: "monitor:pins",
        label: `Pins: ${params.pinnedThreadLimit}`,
        style: "secondary",
        fallbackText: `monitor pins ${nextMonitorThreadLimit(params.pinnedThreadLimit)}`,
        priority: 3,
      },
      {
        id: "monitor:recent",
        label: `Recent: ${params.recentThreadLimit}`,
        style: "secondary",
        fallbackText: `monitor recent ${nextMonitorThreadLimit(params.recentThreadLimit)}`,
        priority: 4,
      },
      {
        id: "monitor:interval",
        label: `Interval: ${formatCompactInterval(params.intervalMs)}`,
        style: "secondary",
        fallbackText: `monitor interval ${formatCompactInterval(
          nextMonitorIntervalMs(params.intervalMs),
        )}`,
        priority: 5,
      },
      {
        id: "monitor:status",
        label: `Status: ${params.showStatusLine ? "Line" : "Inline"}`,
        style: "secondary",
        fallbackText: `monitor status ${params.showStatusLine ? "inline" : "line"}`,
        priority: 6,
      },
      {
        id: "monitor:snippet",
        label: `Snippet: ${params.showSnippets ? "On" : "Off"}`,
        style: "secondary",
        fallbackText: `monitor snippet ${params.showSnippets ? "off" : "on"}`,
        priority: 7,
      },
      ...(params.topicControls
        ? [
            {
              id: "monitor:topics",
              label: "Topics",
              style: "secondary" as const,
              fallbackText: "monitor topics",
              priority: 8,
            },
          ]
        : []),
    ],
    profile,
  );
}

function formatMonitorThreadSections(params: {
  activeTurns: ReadonlyMap<string, MessagingActiveTurnSummary>;
  navigation: NavigationSnapshot;
  now: number;
  selection: MessagingMonitorThreadSelection;
  showSnippets: boolean;
  showStatusLine: boolean;
  snippetsByThreadKey: ReadonlyMap<string, string>;
}): string[] {
  const lines: string[] = [];
  if (params.selection.pinnedThreads.length > 0) {
    lines.push("Pins");
    lines.push(
      ...params.selection.pinnedThreads.map((thread, index) =>
        formatThreadLine({
          index,
          labelPrefix: "P",
          navigation: params.navigation,
          now: params.now,
          showSnippet: params.showSnippets,
          showStatusLine: params.showStatusLine,
          snippet: params.snippetsByThreadKey.get(
            buildThreadIdentityKey(thread.source, thread.id),
          ),
          thread,
          turn: params.activeTurns.get(buildThreadIdentityKey(thread.source, thread.id)),
        }),
      ),
    );
  }

  if (params.selection.recentThreads.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("Recent");
    lines.push(
      ...params.selection.recentThreads.map((thread, index) =>
        formatThreadLine({
          index,
          navigation: params.navigation,
          now: params.now,
          showSnippet: params.showSnippets,
          showStatusLine: params.showStatusLine,
          snippet: params.snippetsByThreadKey.get(
            buildThreadIdentityKey(thread.source, thread.id),
          ),
          thread,
          turn: params.activeTurns.get(buildThreadIdentityKey(thread.source, thread.id)),
        }),
      ),
    );
  }

  if (lines.length > 0) {
    return lines;
  }
  if (
    params.selection.pinnedThreadLimit === 0 &&
    params.selection.recentThreadLimit === 0
  ) {
    return ["No threads selected. Increase Pins or Recent to show items."];
  }
  return ["No matching recent threads."];
}

function formatThreadLine(params: {
  index: number;
  labelPrefix?: string;
  navigation: NavigationSnapshot;
  now: number;
  showSnippet: boolean;
  showStatusLine: boolean;
  snippet?: string;
  thread: NavigationThreadSummary;
  turn?: MessagingActiveTurnSummary;
}): string {
  const title = formatThreadTitle(params.thread);
  const directory = projectLabelForThread(params.navigation, params.thread);
  const state = formatThreadState(params.thread, params.turn);
  const updated = formatRelativeTime(params.thread.updatedAt, params.now);
  const directorySuffix = directory ? ` - ${directory}` : "";
  const label = `${params.labelPrefix ?? ""}${params.index + 1}`;
  const details: string[] = [];
  if (params.showStatusLine) {
    details.push(`  Status: ${state} - ${updated}${directorySuffix}`);
  }
  if (params.showSnippet && params.snippet) {
    details.push(`  Response: ${formatResponseSnippet(params.snippet)}`);
  }

  const firstLine = params.showStatusLine
    ? `${label}. ${title} (${params.thread.source})`
    : `${label}. ${title} (${params.thread.source}) - ${state} - ${updated}${directorySuffix}`;
  return details.length > 0 ? [firstLine, ...details].join("\n") : firstLine;
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
    return "awaiting approval";
  }
  if (thread.queuedExecutionMode) {
    return "queued permissions";
  }
  return "idle";
}

function formatResponseSnippet(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MESSAGING_MONITOR_SNIPPET_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, MESSAGING_MONITOR_SNIPPET_LENGTH - 3)}...`;
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
  if (intervalMs < 60_000) {
    const seconds = Math.max(1, Math.round(intervalMs / 1000));
    return `${seconds} sec`;
  }
  const minutes = Math.max(1, Math.round(intervalMs / 60_000));
  return `${minutes} min`;
}

function formatCompactInterval(intervalMs: number): string {
  if (intervalMs < 60_000) {
    return `${Math.max(1, Math.round(intervalMs / 1000))}s`;
  }
  return `${Math.max(1, Math.round(intervalMs / 60_000))}m`;
}
