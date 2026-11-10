import type { AppServerBackendKind, ArchiveThreadCleanupResult } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "../features/notifications/AppNoticeToast";
import type { ThreadActionErrorContext } from "./thread-action-error-context";

export const BACKGROUND_CLEANUP_REPORT_INTERVAL_MS = 5_000;
const MAX_RECENT_COMPLETIONS = 512;
const MAX_REASONS = 8;
const MAX_DIAGNOSTICS = 5;

/** One window-local report for unsolicited results. No filesystem or durable
 * state: dismissal lasts for this window's lifetime, including later results. */
export class BackgroundArchiveCleanupReport {
  private readonly recent = new Set<string>();
  private readonly reasons = new Map<string, number>();
  private readonly diagnostics = new Set<string>();
  private results = 0;
  private removed = 0;
  private kept = 0;
  private failed = 0;
  private absent = 0;
  private otherReasons = 0;
  private dismissed = false;

  record(backend: AppServerBackendKind, completion: {
    threadId: string; archivedAt: number; cleanup: ArchiveThreadCleanupResult[]; error?: string;
  }, context: ThreadActionErrorContext = {}): boolean {
    if (this.dismissed) return false;
    // Bound redelivery protection as well as the displayed details. Different
    // outcomes for a deferred checkout are separate observations of that thread.
    const key = JSON.stringify([backend, completion.threadId, completion.archivedAt, completion.cleanup, completion.error]);
    if (this.recent.has(key)) return false;
    this.recent.add(key);
    if (this.recent.size > MAX_RECENT_COMPLETIONS) this.recent.delete(this.recent.values().next().value!);
    this.results += 1;
    const reference = [
      ...(context.threadLink ? [`Thread: ${context.threadLink.title}`] : []),
      `Thread ID: ${completion.threadId}`,
      `Backend: ${backend}`,
      ...(context.threadLink?.instanceId ? [`Instance ID: ${context.threadLink.instanceId}`] : []),
    ];
    const diagnostic = (path?: string): string => [...reference, ...(path ? [`Worktree: ${path}`] : [])].join("\n");
    if (completion.error) {
      this.failed += 1;
      this.reason(completion.error, diagnostic());
    }
    for (const item of completion.cleanup) {
      if (item.removedWorktree) this.removed += 1;
      if (item.error) {
        this.failed += 1;
        this.reason(item.error, diagnostic(item.worktreePath));
      } else if (!item.removedWorktree) {
        if (item.skippedReason === "Worktree directory no longer exists.") this.absent += 1;
        else {
          this.kept += 1;
          this.reason(item.skippedReason ?? "Cleanup was skipped; worktree kept.", diagnostic(item.worktreePath));
        }
      }
    }
    return true;
  }

  dismiss(): void { this.dismissed = true; }

  notice(): AppNoticeToastNotice | undefined {
    if (this.dismissed || (this.kept === 0 && this.failed === 0)) return undefined;
    return {
      id: "background-archive-cleanup-summary",
      title: "Background worktree cleanup",
      message: `${this.results} cleanup results · ${this.removed} worktrees removed · ${this.kept} kept · ${this.failed} failed${this.absent ? ` · ${this.absent} already absent` : ""}.`,
      detail: [...this.reasons].map(([reason, count]) => `${count} × ${reason}`)
        .concat(this.otherReasons ? [`${this.otherReasons} other kept or failed outcomes.`] : []).join("\n"),
      facts: [...this.diagnostics].map((value, index) => ({ label: `Cleanup ${index + 1}`, value })),
      autoDismiss: false,
      tone: this.failed ? "warning" : "neutral",
    };
  }

  private reason(reason: string, diagnostic?: string): void {
    if (this.reasons.has(reason) || this.reasons.size < MAX_REASONS) this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
    else this.otherReasons += 1;
    if (diagnostic && this.diagnostics.size < MAX_DIAGNOSTICS) this.diagnostics.add(diagnostic);
  }
}
