import { useEffect, useRef } from "react";
import type { ToastCategory, ToastHistoryPhase, ToastHistorySurface } from "../../../../shared/operator-alert-history";
import { getDesktopApi } from "../../lib/desktop-api";

type Toast = {
  id: string;
  autoDismiss?: boolean;
  historyCategory?: ToastCategory;
};

// The stable part of each existing notice ID identifies its producer. Only
// the enum leaves this lookup; an unknown prefix is never used as a category.
const CATEGORIES = new Map<string, ToastCategory>([
  ["operator-approval", "approval"],
  ["job-monitor-wake", "job-monitor"],
  ["provider-startup", "provider-startup"],
  ["codex-launch-failed", "provider-startup"],
  ["codex-auth", "provider-authentication"],
  ["claude-sign-in", "provider-authentication"],
  ["codex-stream", "provider-stream"],
  ["agent-stream", "provider-stream"],
  ["turn-failed", "turn-failure"],
  ["system-error", "provider-error"],
  ["codex-invalid-id-recovery", "provider-recovery"],
  ["config-file-invalid", "configuration"],
  ["settings-refresh-failed", "configuration"],
  ["auto-access-upgrade", "configuration"],
  ["messaging-platform-error", "messaging"],
  ["federation-shutdown", "federation"],
  ["cloudflare-sign-in-required", "federation"],
  ["github-pr-authentication-failure", "github-access"],
  ["github-pr-saml", "github-access"],
  ["pr-auto-dispatch-budget-paused", "pr-automation"],
  ["pr-watch-stop", "pr-automation"],
  ["merge-build-watch", "pr-automation"],
  ["app-update-check", "app-update"],
  ["codex-version", "provider-update"],
  ["acp-update", "provider-update"],
  ["antigravity-update", "provider-update"],
  ["managed-grok-build", "provider-update"],
  ["managed-grok-signature", "provider-update"],
  ["codex-restart-stopped", "restart"],
  ["restart-gate-resuming", "restart"],
  ["bundled-git-lfs-advisory", "workspace-recovery"],
  ["restore-detached", "workspace-recovery"],
  ["locked-worktrees", "workspace-recovery"],
  ["locked-worktrees-removed", "workspace-recovery"],
  ["locked-worktrees-problem", "workspace-recovery"],
  ["locked-worktree-handoff", "workspace-recovery"],
  ["automatic-archive-retired", "archive"],
  ["archive-cleanup", "archive"],
  ["codex-missing-threads", "archive"],
  ["thread-action-error", "thread-action"],
  ["agent-thread-rename", "thread-action"],
  ["navigation-read-error", "navigation"],
  ["project-reveal", "navigation"],
  ["model-verification", "model-verification"],
  ["automation-load-issues", "automation"],
  ["hot-cpu-profile", "diagnostics"],
  ["heap-snapshot", "diagnostics"],
  ["codex-protocol-capture", "diagnostics"],
  ["native-voice-error", "voice"],
  ["native-voice-ended", "voice"],
  ["quit-blocker-queue", "queue"],
  ["thread-maintenance-session", "thread-maintenance"],
  ["thread-handoff", "handoff"],
  ["launchpad-branches-unavailable", "composer"],
]);

export function toastHistorySurface(notice: Toast): ToastHistorySurface {
  return notice.autoDismiss === false ? "durable-toast" : "transient-toast";
}

export function reportToastHistory(notice: Toast, phase: ToastHistoryPhase, standalone?: true): void {
  try {
    const record = getDesktopApi()?.recordToastHistory;
    if (!record) return;
    const prefix = notice.id.split(/[:\n]/, 1)[0] ?? "";
    const category = notice.historyCategory
      ?? (prefix.startsWith("composer-notice-") ? "composer" : CATEGORIES.get(prefix))
      ?? "other-toast";
    record({ identity: notice.id, category, surface: toastHistorySurface(notice), phase, standalone });
  } catch {
    // Losing the desktop bridge must never prevent a notice action.
  }
}

/** Cards with their own layout still report changes in committed visibility. */
export function useStandaloneToastHistory(id: string | undefined, category: ToastCategory) {
  const previousId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousId.current && previousId.current !== id) {
      reportToastHistory({ id: previousId.current, historyCategory: category, autoDismiss: false }, "withdrawn");
    }
    if (id && previousId.current !== id) {
      reportToastHistory({ id, historyCategory: category, autoDismiss: false }, "displayed", true);
    }
    previousId.current = id;
  }, [id, category]);
  return (phase: "action-invoked" | "dismissed") => {
    if (id) reportToastHistory({ id, historyCategory: category, autoDismiss: false }, phase);
  };
}
