import type { AppServerNotification } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export const CODEX_MISSING_THREADS_CONFIRMATION_NOTICE_ID =
  "codex-missing-threads:confirmation";

export type CodexMissingThreadsSignal = Extract<
  AppServerNotification,
  { method: "codex/missingThreads/updated" }
>["params"];

export function formatMissingThreadShare(params: {
  missingCount: number;
  totalCount: number;
}): string {
  if (params.totalCount <= 0) return "100%";
  const share = (params.missingCount / params.totalCount) * 100;
  // A near-miss reads better rounded than truncated, but 99.6% must not
  // become "100% of threads" while some threads are still fine.
  const rounded = share >= 99.5 && params.missingCount < params.totalCount
    ? 99
    : Math.round(share);
  return `${Math.max(rounded, 1)}%`;
}

function pluralizeThreads(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

/**
 * Builds the notice for a `codex/missingThreads/updated` signal.
 *
 * `confirmationRequired` is the interesting case: a large missing share is
 * more likely a Codex profile mismatch than genuinely deleted sessions, and
 * archiving on that guess would empty a working profile's sidebar. The notice
 * stays durable until the operator answers, and both answers are reversible —
 * archived threads restore, and keeping them only defers the decision.
 */
export function buildCodexMissingThreadsNotice(params: {
  onArchive: () => void;
  onKeep: () => void;
  signal: CodexMissingThreadsSignal;
}): AppNoticeToastNotice | undefined {
  const { signal } = params;
  if (signal.threadIds.length === 0) return undefined;

  const threadDetail = signal.threadIds.length === 1
    ? `Thread: ${signal.threadIds[0]}`
    : `Threads: ${signal.threadIds.slice(0, 3).join(", ")}${signal.threadIds.length > 3 ? ` (+${signal.threadIds.length - 3} more; copy notice for all IDs)` : ""}`;
  const withDiagnostics = (notice: AppNoticeToastNotice): AppNoticeToastNotice => ({
    ...notice,
    detail: `${notice.detail} ${threadDetail}`,
    copyText: [
      notice.title,
      notice.message,
      notice.detail,
      `PwrAgent profile: ${signal.profileName}`,
      `Threads reported missing: ${signal.missingCount} of ${signal.totalCount}`,
      "Affected Codex thread IDs:",
      ...signal.threadIds,
      ...(signal.failures?.length
        ? ["Archive failures:", ...signal.failures.map((failure) =>
            `${failure.threadId}: ${failure.error}`,
          )]
        : []),
    ].filter(Boolean).join("\n"),
  });

  if (signal.status === "archived") {
    const archivedCount = signal.archivedCount ?? 0;
    const failedCount = signal.failedCount ?? 0;
    if (archivedCount === 0 && failedCount === 0) return undefined;

    return withDiagnostics({
      detail: failedCount > 0
        ? `${pluralizeThreads(failedCount)} could not be archived and stayed in the sidebar.`
        : "Restore them from the Archived lens if this was not what you wanted.",
      id: "codex-missing-threads:archived",
      message: archivedCount > 0
        ? `Codex no longer has ${pluralizeThreads(archivedCount)} from this PwrAgent profile, so PwrAgent archived them.`
        : `Codex no longer has ${pluralizeThreads(signal.missingCount)} from this PwrAgent profile, and archiving them failed.`,
      title: archivedCount > 0
        ? "Archived missing threads"
        : "Missing threads not archived",
      tone: failedCount > 0 ? "warning" : "neutral",
      transientSlot: "codex-missing-threads",
    });
  }

  const share = formatMissingThreadShare({
    missingCount: signal.missingCount,
    totalCount: signal.totalCount,
  });

  return withDiagnostics({
    actions: [
      {
        label: "Leave Everything Alone",
        onClick: params.onKeep,
        tone: "secondary",
      },
      {
        label: "Archive the Missing Threads",
        onClick: params.onArchive,
        tone: "primary",
      },
    ],
    autoDismiss: false,
    detail:
      "Archiving removes them from this PwrAgent profile and can be undone from the Archived lens. Leaving them alone changes nothing, and nothing else is archived automatically for the rest of this session.",
    id: CODEX_MISSING_THREADS_CONFIRMATION_NOTICE_ID,
    message: `${share} of the threads in PwrAgent profile "${signal.profileName}" (${signal.missingCount} of ${signal.totalCount}) are reported missing by Codex. That is expected if those Codex sessions were deleted, but it also happens when a PwrAgent profile is connected to the wrong Codex profile.`,
    onDismiss: params.onKeep,
    title: "Threads missing from Codex",
    tone: "warning",
  });
}
