import { createElement } from "react";
import { buildThreadUrl, type AppServerBackendKind, type ArchiveThreadCleanupResult, type ThreadLinkRef } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "../features/notifications/AppNoticeToast";
import { BackgroundArchiveCleanupDetails } from "../features/notifications/BackgroundArchiveCleanupDetails";
import type { BackgroundCleanupOutcome, BackgroundCleanupThread } from "./background-archive-cleanup-types";
import type { ThreadActionErrorContext } from "./thread-action-error-context";

export const BACKGROUND_CLEANUP_REPORT_INTERVAL_MS = 5_000;
const MAX_RECENT_COMPLETIONS = 512;
const MAX_OUTCOMES = 128;
const MAX_RETAINED_CHARS = 256 * 1024;
const MAX_TEXT_CHARS = 2048;
const MAX_BLOCKERS = 32;
const MAX_VISIBLE_OUTCOMES = 5;

type Completion = { threadId: string; archivedAt: number; cleanup: ArchiveThreadCleanupResult[]; error?: string };
type ThreadResolver = (ref: ThreadLinkRef) => (ThreadLinkRef & { title?: string }) | undefined;
const priority = (kind: BackgroundCleanupOutcome["kind"]): number => kind === "failed" ? 3 : kind === "kept" ? 2 : 1;

/** A fixed-size, non-security redelivery fingerprint; large errors must not
 * become 512 retained copies of an unbounded JSON string. */
function completionKey(backend: string, instanceId: string | undefined, completion: Completion): string {
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const primes = [0x01000193, 0x010001a7, 0x010001b3, 0x010001c3];
  const add = (field: string | number | boolean | undefined) => {
    const value = String(field);
    for (let index = -1; index <= value.length; index++) {
      const code = index === -1 ? 0x10001 + (typeof field === "string" ? 1 : typeof field === "number" ? 2 : typeof field === "boolean" ? 3 : 0)
        : index === value.length ? 0x10000 : value.charCodeAt(index);
      for (let lane = 0; lane < hashes.length; lane++) hashes[lane] = Math.imul(hashes[lane] ^ code, primes[lane]);
    }
  };
  [backend, instanceId, completion.threadId, completion.archivedAt, completion.error, completion.cleanup.length].forEach(add);
  for (const item of completion.cleanup) {
    [item.worktreePath, item.branch, item.removedWorktree, item.deletedBranch, item.error, item.skippedReason, item.blockingThreads?.length].forEach(add);
    for (const thread of item.blockingThreads ?? []) [thread.backend, thread.threadId, thread.title].forEach(add);
  }
  return hashes.map((hash) => (hash >>> 0).toString(16).padStart(8, "0")).join("");
}

function threadText(thread: BackgroundCleanupThread): string {
  return [`Thread: ${thread.title || "Unknown thread"}`, `Thread ID: ${thread.ref.threadId}`,
    `Backend: ${thread.ref.backend ?? "unknown"}`, `Instance ID: ${thread.ref.instanceId ?? "local"}`,
    `Thread link: ${buildThreadUrl(thread.ref)}`].join("\n");
}

function outcomeText(outcome: BackgroundCleanupOutcome): string {
  return [outcome.kind.toUpperCase(), threadText(outcome.source), `Worktree: ${outcome.worktreePath ?? "unavailable"}`,
    `Reason: ${outcome.reason}`,
    ...outcome.blockers.map((thread, index) => `Blocking thread ${index + 1}\n${threadText(thread)}`),
    ...(outcome.blockerCount > outcome.blockers.length ? [`Storage limit: ${outcome.blockerCount - outcome.blockers.length} blocking thread references omitted.`] : []),
    ...(outcome.textTruncated ? [`Storage limit: text fields truncated at ${MAX_TEXT_CHARS} characters [truncated].`] : []),
  ].join("\n");
}

/** Window-local, bounded diagnostics. Failures displace lower-priority records;
 * the compact view never limits Copy to its first five outcomes. */
export class BackgroundArchiveCleanupReport {
  private readonly recent = new Set<string>();
  private readonly outcomes: Array<{ outcome: BackgroundCleanupOutcome; chars: number }> = [];
  private readonly omitted = { failed: 0, kept: 0, removed: 0, absent: 0 };
  private retainedChars = 0;
  private results = 0;
  private removed = 0;
  private kept = 0;
  private failed = 0;
  private absent = 0;
  private dismissed = false;

  record(backend: AppServerBackendKind, completion: Completion, context: ThreadActionErrorContext = {}, resolve?: ThreadResolver): boolean {
    if (this.dismissed) return false;
    const instanceId = context.threadLink?.instanceId;
    const key = completionKey(backend, instanceId, completion);
    if (this.recent.has(key)) return false;
    // A retry still held by the same threads was reported when it first
    // happened; repeating it at every launch is noise.
    const cleanup = completion.cleanup.filter((item) => !item.unchanged);
    if (!completion.error && completion.cleanup.length > 0 && cleanup.length === 0) return false;
    this.recent.add(key);
    if (this.recent.size > MAX_RECENT_COMPLETIONS) this.recent.delete(this.recent.values().next().value!);
    this.results++;
    const add = (kind: BackgroundCleanupOutcome["kind"], reason: string, item?: ArchiveThreadCleanupResult) => {
      let textTruncated = false;
      const clip = (value: string | undefined): string | undefined => {
        if (!value || value.length <= MAX_TEXT_CHARS) return value;
        textTruncated = true;
        return value.slice(0, MAX_TEXT_CHARS) + " [truncated]";
      };
      const thread = (ref: ThreadLinkRef, title?: string): BackgroundCleanupThread => {
        const found = resolve?.(ref);
        const matching = found?.threadId === ref.threadId && found.instanceId === ref.instanceId
          && (!ref.backend || found.backend === ref.backend) ? found : undefined;
        const name = title || matching?.title;
        return { ref: { ...ref, ...(matching?.backend ? { backend: matching.backend } : {}) },
          title: clip(name?.trim() && name.trim() !== ref.threadId ? name.trim() : undefined) };
      };
      const source = thread({ backend, threadId: completion.threadId, ...(instanceId ? { instanceId } : {}) },
        context.threadLink?.threadId === completion.threadId && context.threadLink.backend === backend ? context.threadLink.title : undefined);
      // Older peers report only ids in this exact sentence. Keep their backend
      // unknown unless the same owner's directory can resolve it unambiguously.
      const legacy = /^Worktree is still used by (?:another active thread|other active threads): (.+)\.$/.exec(item?.skippedReason ?? "");
      const refs: Array<ThreadLinkRef & { title?: string }> = item?.blockingThreads?.map((ref) => ({ ...ref, ...(instanceId ? { instanceId } : {}) }))
        ?? (legacy ? legacy[1].split(", ").map((threadId) => ({ threadId, ...(instanceId ? { instanceId } : {}) })) : []);
      const blockers = refs.slice(0, MAX_BLOCKERS).map((ref) => thread(ref, ref.title));
      const worktreePath = clip(item?.worktreePath);
      const clippedReason = clip(reason)!;
      this.retain({ kind, source, reason: clippedReason, worktreePath, blockers, blockerCount: refs.length, textTruncated });
    };
    if (completion.error) { this.failed++; add("failed", completion.error); }
    for (const item of cleanup) {
      if (item.removedWorktree) this.removed++;
      if (item.error) { this.failed++; add("failed", item.error, item); }
      else if (item.removedWorktree) add("removed", "Worktree removed.", item);
      else if (item.skippedReason === "Worktree directory no longer exists.") { this.absent++; add("absent", item.skippedReason, item); }
      else { this.kept++; add("kept", item.skippedReason ?? "Cleanup was skipped; worktree kept.", item); }
    }
    return true;
  }

  dismiss(): void {
    this.dismissed = true;
    this.outcomes.length = 0;
    this.recent.clear();
    this.retainedChars = 0;
  }

  notice(): AppNoticeToastNotice | undefined {
    if (this.dismissed || (this.kept === 0 && this.failed === 0)) return undefined;
    const retained = this.outcomes.map(({ outcome }) => outcome).sort((a, b) => priority(b.kind) - priority(a.kind));
    const attention = retained.filter((outcome) => outcome.kind === "failed" || outcome.kind === "kept");
    const visible = attention.slice(0, MAX_VISIBLE_OUTCOMES);
    const hiddenFailed = attention.slice(visible.length).filter((outcome) => outcome.kind === "failed").length;
    const hiddenKept = attention.length - visible.length - hiddenFailed;
    const omitted = Object.values(this.omitted).reduce((sum, count) => sum + count, 0);
    const limit = omitted ? `Storage limit: ${this.omitted.failed} failed, ${this.omitted.kept} kept, ${this.omitted.removed} removed and ${this.omitted.absent} absent outcomes omitted from this view and Copy.` : undefined;
    const truncated = retained.some((outcome) => outcome.textTruncated || outcome.blockerCount > outcome.blockers.length)
      ? "Some text or blocking references were truncated at the storage limit; Copy states the limits." : undefined;
    const message = `${this.results} cleanup results · ${this.removed} worktrees removed · ${this.kept} kept · ${this.failed} failed${this.absent ? ` · ${this.absent} already absent` : ""}.`;
    const detail = [hiddenFailed + hiddenKept ? `${hiddenFailed} failed and ${hiddenKept} kept outcomes not shown. Copy includes all ${retained.length} retained outcomes.`
      : `Copy includes all ${retained.length} retained outcomes.`, limit, truncated].filter(Boolean).join("\n");
    return {
      id: "background-archive-cleanup-summary", title: "Background worktree cleanup", message, detail,
      body: createElement(BackgroundArchiveCleanupDetails, { outcomes: visible }),
      copyText: ["Background worktree cleanup", message, detail, ...retained.map(outcomeText)].join("\n\n"),
      autoDismiss: false,
      tone: this.failed ? "warning" : "neutral",
    };
  }

  private retain(outcome: BackgroundCleanupOutcome): void {
    const chars = JSON.stringify(outcome).length + outcomeText(outcome).length;
    if (chars <= MAX_RETAINED_CHARS) {
      const incoming = priority(outcome.kind);
      while (this.outcomes.length >= MAX_OUTCOMES || this.retainedChars + chars > MAX_RETAINED_CHARS) {
        // Evict the oldest record of the lowest kind below this one, so a
        // failure takes a removed record before a kept one.
        let index = -1;
        let lowest = incoming;
        for (let at = 0; at < this.outcomes.length; at++) {
          const rank = priority(this.outcomes[at]!.outcome.kind);
          if (rank < lowest) { index = at; lowest = rank; }
        }
        if (index < 0) break;
        const [removed] = this.outcomes.splice(index, 1);
        this.retainedChars -= removed.chars;
        this.omitted[removed.outcome.kind]++;
      }
      if (this.outcomes.length < MAX_OUTCOMES && this.retainedChars + chars <= MAX_RETAINED_CHARS) {
        this.outcomes.push({ outcome, chars });
        this.retainedChars += chars;
        return;
      }
    }
    this.omitted[outcome.kind]++;
  }
}
