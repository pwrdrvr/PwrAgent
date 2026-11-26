export const RECORD_TOAST_HISTORY_CHANNEL = "diagnostics:record-toast-history";
export const READ_OPERATOR_ALERT_HISTORY_CHANNEL = "diagnostics:read-operator-alert-history";

export const TOAST_CATEGORIES = [
  "approval", "job-monitor", "provider-startup", "provider-authentication",
  "provider-stream", "turn-failure", "provider-error", "provider-recovery",
  "configuration", "messaging", "federation", "github-access", "pr-automation",
  "app-update", "provider-update", "restart", "workspace-recovery", "archive",
  "thread-action", "navigation", "spend", "tool-accounting", "model-verification",
  "automation", "diagnostics", "voice", "queue", "thread-maintenance", "handoff",
  "composer", "other-toast",
] as const;

export const NATIVE_ALERT_CATEGORIES = [
  "attention", "approval", "turn-completed", "turn-failed", "turn-cancelled",
] as const;

export const TOAST_HISTORY_PHASES = [
  "queued", "displayed", "dismissed", "action-invoked", "expired", "withdrawn",
] as const;

export const NATIVE_HISTORY_PHASES = [
  "submitted", "displayed", "failed", "unsupported", "clicked", "action-invoked",
  "closed", "cleared",
] as const;

export type ToastCategory = (typeof TOAST_CATEGORIES)[number];
export type ToastHistoryPhase = (typeof TOAST_HISTORY_PHASES)[number];
export type ToastHistorySurface = "durable-toast" | "transient-toast";
export type NativeAlertCategory = (typeof NATIVE_ALERT_CATEGORIES)[number];
export type NativeHistoryPhase = (typeof NATIVE_HISTORY_PHASES)[number];
export type AlertHistoryPhase = ToastHistoryPhase | NativeHistoryPhase;

export type ToastHistoryObservation = {
  // Used only for correlation. It is never written verbatim or returned.
  identity: string;
  category: ToastCategory;
  surface: ToastHistorySurface;
  phase: ToastHistoryPhase;
  /** Standalone toasts can start a row on display. Stack cards start on queue. */
  standalone?: true;
};

export type NativeAlertObservation = {
  identity: string;
  category: NativeAlertCategory;
  surface: "native";
  phase: NativeHistoryPhase;
};

export type OperatorAlertHistory = {
  version: 1;
  capacity: number;
  evictedCount: number;
  droppedObservationCount: number;
  alerts: {
    category: ToastCategory | NativeAlertCategory;
    surface: ToastHistorySurface | "native";
    milestones: Partial<Record<AlertHistoryPhase, number>>;
  }[];
};
