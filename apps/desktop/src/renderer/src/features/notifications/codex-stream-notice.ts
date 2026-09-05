import type { FederationInstanceId } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export type CodexStreamSignal = {
  notification: { method: string; params: Record<string, unknown> };
  instanceId?: FederationInstanceId;
  threadLabel: string;
};

const MODEL_PROGRESS_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/plan/delta",
]);

export function isCodexStreamNoticeMethod(method: string): boolean {
  return method === "error"
    || method === "warning"
    || method === "turn/completed"
    || method === "turn/failed"
    || method === "turn/cancelled"
    || MODEL_PROGRESS_METHODS.has(method);
}

/** Structured App Server errors describe upstream retries; stdio can remain healthy. */
export function resolveCodexStreamNotice(
  signal: CodexStreamSignal,
  notices: readonly AppNoticeToastNotice[],
): { notice: AppNoticeToastNotice } | { dismissId: string } | undefined {
  const { method, params } = signal.notification;
  if (!isCodexStreamNoticeMethod(method)) return undefined;
  const threadId = readText(params.threadId);
  if (!threadId) return undefined;
  const turnId = readText(params.turnId);
  const id = `codex-stream:${JSON.stringify([
    signal.instanceId ?? "local",
    threadId,
    turnId ?? null,
  ])}`;
  const current = notices.find((notice) => notice.id === id);

  if (method === "error" || method === "warning") {
    const error = params.error && typeof params.error === "object"
      ? params.error as Record<string, unknown>
      : undefined;
    const message = readText(method === "warning" ? params.message : error?.message);
    if (!message) return undefined;
    const details = readText(error?.additionalDetails);
    const retrying = method === "error" && params.willRetry === true;
    return {
      notice: {
        id,
        // Warnings have no turn ID or matching completion signal. Show the
        // fallback information without leaving a stale retry incident behind.
        autoDismiss: method === "warning",
        title: method === "warning"
          ? "Codex warning"
          : retrying ? "Codex is retrying" : "Codex error",
        message: details ? `${message}\n${details}` : message,
        tone: method === "warning" || retrying ? "warning" : "error",
        detail: signal.threadLabel,
        threadLink: {
          backend: "codex",
          threadId,
          title: signal.threadLabel,
          ...(signal.instanceId ? { instanceId: signal.instanceId } : {}),
        },
        ...(retrying ? {
          status: {
            label: "The turn is still active. Codex will retry automatically.",
            state: "progress" as const,
          },
        } : {}),
      },
    };
  }

  if (!current || current.autoDismiss !== false) return undefined;
  if (method === "turn/failed" || method === "turn/cancelled") {
    return { dismissId: id };
  }
  // A running local command can emit output while the model is unreachable.
  // Only new model text or successful completion establishes recovery.
  if (MODEL_PROGRESS_METHODS.has(method) && !readText(params.delta)) return undefined;
  return {
    notice: {
      ...current,
      autoDismiss: true,
      title: method === "turn/completed" ? "Codex turn completed" : "Codex resumed",
      message: method === "turn/completed"
        ? "The turn completed after the reported problem."
        : "Codex is producing output again.",
      tone: "success",
      status: { label: "Reported problem cleared.", state: "success" },
    },
  };
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
