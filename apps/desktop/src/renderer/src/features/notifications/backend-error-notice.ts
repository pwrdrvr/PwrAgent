import type { AppNoticeToastNotice } from "./AppNoticeToast";

/**
 * A backend failure signal worth surfacing as a sticky toast. Either a
 * `turn/failed` (carries the real error text) or a
 * `thread/status/changed` → systemError (generic). `threadLabel` is a
 * human-readable name for the originating thread (its title, or a backend
 * fallback) so a mid-outage toast says *which* thread broke.
 */
export type BackendErrorSignal =
  | {
      kind: "codex-invalid-id-recovery";
      status: "repairing" | "succeeded" | "failed";
      threadId: string;
      turnId: string;
      failureMessage: string;
      recoveryError?: string;
      threadLabel: string;
    }
  | {
      kind: "turn-failed";
      backend: string;
      threadId: string;
      turnId: string;
      errorMessage: string;
      threadLabel: string;
    }
  | {
      kind: "system-error";
      backend: string;
      threadId: string;
      threadLabel: string;
    };

/**
 * Compute the next sticky backend-error notice from a signal and the
 * currently-displayed notice.
 *
 * Notices are keyed by `(backend, threadId)` so a failure on one thread
 * never suppresses a signal from another — last-write-wins replaces a
 * stale toast rather than dropping the new one. The one exception: a
 * `systemError` does not downgrade a `turn/failed` notice for the SAME
 * thread, because the two fire together during one outage and the
 * `turn/failed` carries the actionable error text.
 */
export function resolveBackendErrorNotice(
  signal: BackendErrorSignal,
  current: AppNoticeToastNotice | undefined,
): AppNoticeToastNotice | undefined {
  if (signal.kind === "codex-invalid-id-recovery") {
    const baseNotice = {
      detail: signal.threadLabel,
      id:
        `codex-invalid-id-recovery:codex:${signal.threadId}:${signal.turnId}`,
      message: signal.failureMessage,
    };
    if (signal.status === "repairing") {
      return {
        ...baseNotice,
        autoDismiss: false,
        status: {
          label:
            "PwrAgent is repairing the saved thread history and will retry your message.",
          state: "progress",
        },
        title: "Known Codex issue",
        tone: "warning",
      };
    }
    if (signal.status === "succeeded") {
      return {
        ...baseNotice,
        autoDismiss: true,
        status: {
          label: "Saved history repaired. Your message was retried.",
          state: "success",
        },
        title: "Codex thread repaired",
        tone: "success",
      };
    }
    return {
      ...baseNotice,
      autoDismiss: false,
      status: {
        label: signal.recoveryError
          ? `Automatic repair failed: ${signal.recoveryError}`
          : "PwrAgent could not complete the automatic repair.",
        state: "error",
      },
      title: "Codex repair failed",
      tone: "error",
    };
  }

  if (signal.kind === "turn-failed") {
    return {
      autoDismiss: false,
      id: `turn-failed:${signal.backend}:${signal.threadId}:${signal.turnId}`,
      title: "Turn failed",
      message: signal.errorMessage,
      detail: signal.threadLabel,
      copyText: signal.errorMessage,
    };
  }

  // Same-thread turn/failed already on screen carries the richer message —
  // don't replace it with the generic system-error copy.
  const sameThreadTurnFailedPrefix = `turn-failed:${signal.backend}:${signal.threadId}:`;
  const sameThreadCodexRecoveryPrefix =
    `codex-invalid-id-recovery:codex:${signal.threadId}:`;
  if (
    current
    && (
      current.id.startsWith(sameThreadTurnFailedPrefix)
      || (
        signal.backend === "codex"
        && current.id.startsWith(sameThreadCodexRecoveryPrefix)
      )
    )
  ) {
    return current;
  }

  return {
    autoDismiss: false,
    id: `system-error:${signal.backend}:${signal.threadId}`,
    title: "Agent backend error",
    message:
      "The agent backend reported a system error. The active turn may have stopped.",
    detail: signal.threadLabel,
  };
}
