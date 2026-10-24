import type { AppServerBackendKind, FederationInstanceId } from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import {
  codexWarningSuppressionId,
  isCodexWarningSuppressed,
} from "../codex-config/codex-warning-suppression";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export type CodexStreamSignal = {
  /** Codex when omitted. ACP backends send retries in the same shape. */
  backend?: AppServerBackendKind;
  notification: { method: string; params: Record<string, unknown> };
  instanceId?: FederationInstanceId;
  skillQuestionsWarningDismissed?: boolean;
  /** Saved `experimental.codexConfigWarningsDismissed` ids. */
  dismissedWarningIds?: readonly string[];
  threadLabel: string;
};

const UNDER_DEVELOPMENT_FEATURES_PREFIX = "Under-development features enabled:";
const SKILL_QUESTIONS_FEATURE = "default_mode_request_user_input";

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
    || method === "turn/recovered"
    || MODEL_PROGRESS_METHODS.has(method);
}

/** Codex and ACP backends report model retries; Claude does not. */
export function isStreamNoticeEvent(
  backend: AppServerBackendKind,
  method: string,
): boolean {
  return (backend === "codex" || backend.startsWith("acp:"))
    && isCodexStreamNoticeMethod(method);
}

/** Structured App Server errors describe upstream retries; stdio can remain healthy. */
export function resolveCodexStreamNotice(
  signal: CodexStreamSignal,
  notices: readonly AppNoticeToastNotice[],
): { notice: AppNoticeToastNotice } | { dismissId: string } | undefined {
  const { method, params } = signal.notification;
  if (!isCodexStreamNoticeMethod(method)) return undefined;
  if (method === "warning" && params.presentation === "activity-only") return undefined;
  const threadId = readText(params.threadId);
  if (!threadId) return undefined;
  const turnId = readText(params.turnId);
  const backend = signal.backend ?? "codex";
  // Codex keeps its original id; an ACP thread can share a Codex thread's ids.
  const id = backend === "codex"
    ? `codex-stream:${JSON.stringify([
      signal.instanceId ?? "local",
      threadId,
      turnId ?? null,
    ])}`
    : `agent-stream:${JSON.stringify([
      backend,
      signal.instanceId ?? "local",
      threadId,
      turnId ?? null,
    ])}`;
  const provider = backend === "codex" ? "Codex" : formatBackendLabel(backend);
  const current = notices.find((notice) => notice.id === id);

  if (method === "error" || method === "warning") {
    const error = params.error && typeof params.error === "object"
      ? params.error as Record<string, unknown>
      : undefined;
    const message = readText(method === "warning" ? params.message : error?.message);
    if (!message) return undefined;
    const skillQuestionsWarning = method === "warning"
      && isSkillQuestionsDevelopmentWarning(message);
    if (skillQuestionsWarning && signal.skillQuestionsWarningDismissed) return undefined;
    // Codex repeats a config requirement warning on every thread. It shares
    // the config banner's saved dismissals, so either surface silences both.
    const warningSuppressionId = method === "warning" && !skillQuestionsWarning
      ? codexWarningSuppressionId({
          summary: message,
          remoteInstanceId: signal.instanceId,
        })
      : undefined;
    if (
      warningSuppressionId
      && isCodexWarningSuppressed(signal.dismissedWarningIds, message, signal.instanceId)
    ) {
      return undefined;
    }
    const details = readText(error?.additionalDetails);
    const retrying = method === "error" && params.willRetry === true;
    return {
      notice: {
        id,
        // Warnings have no turn ID or matching completion signal. Show the
        // fallback information without leaving a stale retry incident behind.
        autoDismiss: method === "warning",
        title: method === "warning"
          ? `${provider} warning`
          : retrying ? `${provider} is retrying` : `${provider} error`,
        message: details ? `${message}\n${details}` : message,
        ...(skillQuestionsWarning ? { skillQuestionsWarning: true } : {}),
        ...(warningSuppressionId ? { warningSuppressionId } : {}),
        tone: method === "warning" || retrying ? "warning" : "error",
        detail: signal.threadLabel,
        threadLink: {
          backend,
          threadId,
          title: signal.threadLabel,
          ...(signal.instanceId ? { instanceId: signal.instanceId } : {}),
        },
        ...(retrying ? {
          status: {
            label: `The turn is still active. ${provider} will retry automatically.`,
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
  if (method === "turn/completed") {
    const turn = params.turn && typeof params.turn === "object"
      ? params.turn as Record<string, unknown>
      : undefined;
    const status = readText(turn?.status);
    // Codex also uses turn/completed for interrupted turns. Only an
    // explicitly successful terminal status establishes recovery.
    if (status === "interrupted" || status === "cancelled" || status === "failed") {
      return { dismissId: id };
    }
    if (status !== "completed") return undefined;
  }
  // A running local command can emit output while the model is unreachable.
  // Only new model text or successful completion establishes recovery.
  if (MODEL_PROGRESS_METHODS.has(method) && !readText(params.delta)) return undefined;
  return {
    notice: {
      ...current,
      autoDismiss: true,
      title: method === "turn/completed"
        ? `${provider} turn completed`
        : `${provider} resumed`,
      message: method === "turn/completed"
        ? "The turn completed after the reported problem."
        : `${provider} is producing output again.`,
      tone: "success",
      status: { label: "Reported problem cleared.", state: "success" },
    },
  };
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSkillQuestionsDevelopmentWarning(message: string): boolean {
  if (!message.startsWith(UNDER_DEVELOPMENT_FEATURES_PREFIX)) return false;
  const featureList = message.slice(UNDER_DEVELOPMENT_FEATURES_PREFIX.length)
    .split(".", 1)[0] ?? "";
  return featureList.split(/[,\s]+/).includes(SKILL_QUESTIONS_FEATURE);
}
