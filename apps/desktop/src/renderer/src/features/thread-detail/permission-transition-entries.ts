import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  ThreadExecutionMode,
  ThreadPermissionTransition,
} from "@pwragent/shared";

/**
 * Synthetic activity entries built from `permissionTransitionLog` are
 * tagged with this id prefix so the transcript dispatcher can route
 * them to the dedicated renderer (or a distinct className) without
 * confusing them with codex-emitted activities.
 */
export const PERMISSION_TRANSITION_ENTRY_PREFIX = "permission-transition-";

const EXECUTION_MODE_LABELS: Record<ThreadExecutionMode, string> = {
  default: "Default Access",
  "full-access": "Full Access",
};

const STATUS_ICON: Record<ThreadPermissionTransition["status"], string> = {
  queued: "\u{1F552}", // 🕒
  applied: "\u{1F513}", // 🔓
  cancelled: "✕", // ✕
};

function formatExecutionModeLabel(mode: ThreadExecutionMode): string {
  return EXECUTION_MODE_LABELS[mode] ?? mode;
}

function summarizeTransition(transition: ThreadPermissionTransition): string {
  const from =
    transition.fromLabel ?? formatExecutionModeLabel(transition.fromExecutionMode);
  const to = transition.toLabel ?? formatExecutionModeLabel(transition.toExecutionMode);
  const icon = STATUS_ICON[transition.status];
  switch (transition.status) {
    case "queued":
      return `${icon} Permissions queue: ${from} → ${to}`;
    case "applied":
      return `${icon} Permissions changed: ${from} → ${to}`;
    case "cancelled":
      return `${icon} Cancelled queued permissions change (${from} → ${to})`;
    default:
      return `${icon} Permissions: ${from} → ${to}`;
  }
}

function toneFor(
  transition: ThreadPermissionTransition,
): "warning" | undefined {
  // Per plan: queued + cancelled + applied-from-queue render with the
  // warning tone. An applied transition that was NOT queued (i.e. the
  // user toggled while idle and the change applied immediately) is
  // routine and renders without the warning treatment.
  if (transition.status === "applied" && !transition.queueId) {
    return undefined;
  }
  return "warning";
}

export function buildPermissionTransitionActivityEntries(
  transitions: ThreadPermissionTransition[] | undefined,
): AppServerThreadActivityEntry[] {
  if (!transitions || transitions.length === 0) {
    return [];
  }
  return transitions.map((transition) => ({
    type: "activity",
    id: `${PERMISSION_TRANSITION_ENTRY_PREFIX}${transition.id}`,
    summary: summarizeTransition(transition),
    createdAt: transition.occurredAt,
    tone: toneFor(transition),
    details: [],
  }));
}

/**
 * Splice synthetic permission-transition activity entries into the
 * transcript entries list, preserving stable order by `createdAt` /
 * `occurredAt` so the transitions appear inline at the moment they
 * happened.
 */
export function injectPermissionTransitions(
  entries: AppServerThreadEntry[],
  transitions: ThreadPermissionTransition[] | undefined,
): AppServerThreadEntry[] {
  const synthetic = buildPermissionTransitionActivityEntries(transitions);
  if (synthetic.length === 0) {
    return entries;
  }
  const merged: AppServerThreadEntry[] = [...entries, ...synthetic];
  merged.sort((left, right) => {
    const leftAt = left.createdAt ?? 0;
    const rightAt = right.createdAt ?? 0;
    if (leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    // Stable tie-break: existing entries before synthetic transitions
    // when timestamps match, so a transition recorded at the exact
    // moment a turn entry exists doesn't shove the turn entry around.
    const leftIsTransition = left.id.startsWith(
      PERMISSION_TRANSITION_ENTRY_PREFIX,
    );
    const rightIsTransition = right.id.startsWith(
      PERMISSION_TRANSITION_ENTRY_PREFIX,
    );
    if (leftIsTransition === rightIsTransition) {
      return 0;
    }
    return leftIsTransition ? 1 : -1;
  });
  return merged;
}

export function isPermissionTransitionEntry(
  entry: AppServerThreadEntry,
): boolean {
  return entry.id.startsWith(PERMISSION_TRANSITION_ENTRY_PREFIX);
}
