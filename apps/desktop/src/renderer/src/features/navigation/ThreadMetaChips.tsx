import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { isBranchDrifted, operatorTodoItemKey } from "@pwragent/shared";
import {
  BranchIcon,
  ContinueAfterIcon,
  DraftIcon,
  FolderIcon,
  PauseIcon,
  TerminalIcon,
  TodoIcon,
  WorktreeIcon,
} from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { useProviderChipNeeded } from "./provider-chip-visibility";
import { copyText } from "../../lib/copy-text";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { useThreadTodosForKey } from "../thread-todos/useThreadTodos";
import {
  isBlockingWait,
  leadingOperatorWait,
  operatorWaitLabel,
  type OperatorWait,
} from "../operator-requests/operator-waits";
import { useOperatorWaitsContext } from "../operator-requests/useOperatorRequests";
import {
  useThreadDependencyIndicator,
  useThreadDependencyIndicatorsContext,
} from "../thread-dependencies/useThreadDependencyIndicators";
import { InstanceChip } from "../federation/InstanceGlyph";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import type { ThreadQueuedMessageState } from "../../lib/useThreadQueuedMessageIndicators";
import { AgentThreadChip } from "./AgentThreadChip";

const NO_WAITS: OperatorWait[] = [];

type ThreadMetaChipsProps = {
  hasApprovalRequest?: boolean;
  /**
   * Unsent composer text is parked on this thread. Distinct from "Queued" and
   * "Scheduled", which are messages already committed to send — a draft is
   * work the operator has not decided to send at all, and is the one pending
   * state nothing else will ever clear for them.
   */
  hasUnsentDraft?: boolean;
  /** A shell is alive for this thread — the row is how you find it again. */
  hasIntegratedTerminal?: boolean;
  hasInputRequest?: boolean;
  /**
   * When set, renders the "Held" (waiting on the operator to retry or
   * delete), "Scheduled" (future send time) or "Queued" (waiting on the
   * active turn) chip. Resolved upstream so a thread with several pending
   * states shows only the highest-priority one.
   */
  queuedMessageState?: ThreadQueuedMessageState;
  includeLinkedDirectories?: boolean;
  linkedDirectoryMode?: "label" | "kind";
  /**
   * Optional per-surface chip trimming. Defaults keep every chip, so the
   * thread list is unaffected; the Star Map uses it to let an operator
   * choose how dense a card should be.
   */
  chipVisibility?: {
    /** Backend/provider chip. */
    provider?: boolean;
    /** Git branch chip. */
    branch?: boolean;
    /** Cap on linked-directory chips (undefined shows all). */
    maxLinkedDirectories?: number;
  };
  /**
   * Suppresses the owning-instance chip for surfaces that already carry
   * that identity (the Star Map groups cards under their instance and
   * watermarks them), where a per-card machine name is pure noise.
   */
  hideInstanceChip?: boolean;
  /**
   * PR chips, slotted into the flow right after the linked-directory
   * chips and BEFORE the branch chip. The owner (ThreadRow) still
   * renders them — this slot only fixes their position: provider +
   * location are short fixed-width chips, PR chips are the actionable
   * work product, and the branch is the longest, least-scanned string,
   * so packing PRs before it keeps them on the first chip line instead
   * of trailing the row.
   */
  prChips?: ReactNode;
  thread: NavigationThreadSummary;
};

export function ThreadMetaChips({
  hasApprovalRequest = false,
  hasUnsentDraft = false,
  hasIntegratedTerminal = false,
  hasInputRequest = false,
  queuedMessageState,
  includeLinkedDirectories = false,
  linkedDirectoryMode = "label",
  hideInstanceChip = false,
  prChips,
  chipVisibility,
  thread,
}: ThreadMetaChipsProps) {
  const providerChipNeeded = useProviderChipNeeded(thread.source);
  const showProvider = (chipVisibility?.provider ?? true) && providerChipNeeded;
  const showBranch = chipVisibility?.branch ?? true;
  const maxLinkedDirectories = chipVisibility?.maxLinkedDirectories;
  const gitStateTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  // Sidebar rows are a clipped scroll region, so a native `title` gets
  // edge-clipped — the viewport tooltip is what the neighbouring chips use.
  const terminalTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  // Same reason as the terminal chip: the sidebar clips a native `title`, and
  // the Star Map layer would paint over one anyway.
  const draftTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const todoTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const itemThreadKey = threadSummaryIdentityKey(thread);
  const openTodos = useThreadTodosForKey(itemThreadKey);
  const waitTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  // Queue entries carry the same owner identity as navigation. The session's
  // own approval and input flags still show when the queue has no matching wait.
  const waitsContext = useOperatorWaitsContext();
  const waitsKnown = Boolean(waitsContext);
  const waits = waitsKnown
    ? waitsContext?.waitsByThreadKey.get(itemThreadKey) ?? NO_WAITS
    : NO_WAITS;
  const leadWait = leadingOperatorWait(waits);
  // Questions rank after every blocking wait, so a question lead means the
  // thread waits only on questions, and the lead is the newest.
  const openQuestion = leadWait?.kind === "question" ? waitsContext?.openWait : undefined;
  const waitTooltipText = (): string => openQuestion
    ? `${formatWaitTooltip(waits)}\nClick to show the latest question`
    : formatWaitTooltip(waits);
  // The row would open the thread at its bottom; the chip opens the
  // question's card.
  const openLeadQuestion = (event: SyntheticEvent): void => {
    if (!openQuestion || !leadWait) return;
    event.preventDefault();
    event.stopPropagation();
    waitTooltip.hide();
    openQuestion(leadWait);
  };
  // Continue After registrations on this thread. The chip opens the dialog
  // wherever one can open, and is a plain status marker elsewhere.
  const dependency = useThreadDependencyIndicator(thread);
  const openContinueAfter = useThreadDependencyIndicatorsContext()?.open;
  const dependencyTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const dependencyTooltipText = dependency
    ? openContinueAfter ? `${dependency.tooltip}\nClick to manage` : dependency.tooltip
    : "";
  const openItemCount = openTodos.length + waits.length;
  // "to-do" while only cards are open, so the chip names what it counts.
  const openItemNoun = waits.length === 0 ? "to-do" : "item";
  const unreadItemCount = waitsKnown && waitsContext
    ? waits.filter((wait) => !waitsContext.seenKeys.has(wait.key)).length
      + openTodos.filter((todo) => !waitsContext.seenKeys.has(operatorTodoItemKey(todo.id))).length
    : 0;
  const branchDrifted = isBranchDrifted(thread.gitBranch, thread.observedGitBranch);
  const branchChip = thread.gitBranch ?? thread.observedGitBranch;
  const gitWorking = thread.gitWorkingState;
  const branchTooltip = useMemo(
    () => branchChip ? formatBranchTooltip(branchChip, gitWorking) : undefined,
    [branchChip, gitWorking],
  );
  const hasDirtyState = Boolean(
    gitWorking &&
      (gitWorking.dirtyFiles > 0 ||
        gitWorking.dirtyAdditions > 0 ||
        gitWorking.dirtyDeletions > 0),
  );
  const hasDirtyLineStats = Boolean(
    gitWorking &&
      (gitWorking.dirtyAdditions > 0 || gitWorking.dirtyDeletions > 0),
  );
  const hasUntracked = Boolean(gitWorking && gitWorking.untrackedFiles > 0);
  const dirtyTooltip = gitWorking
    ? [
        hasDirtyState
          ? hasDirtyLineStats
            ? `Uncommitted changes: ${gitWorking.dirtyFiles} file${
                gitWorking.dirtyFiles === 1 ? "" : "s"
              }, +${gitWorking.dirtyAdditions.toLocaleString()}, -${gitWorking.dirtyDeletions.toLocaleString()}`
            : `Uncommitted changes: ${gitWorking.dirtyFiles} file${
                gitWorking.dirtyFiles === 1 ? "" : "s"
              }`
          : undefined,
        hasUntracked
          ? `${gitWorking.untrackedFiles} untracked file${
              gitWorking.untrackedFiles === 1 ? "" : "s"
            }`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  const unpushedCount = gitWorking?.unpushedCommits ?? 0;
  const unpushedTooltip = `${unpushedCount} commit${
    unpushedCount === 1 ? "" : "s"
  } not pushed to a remote`;
  const currentBranch =
    thread.observedGitBranch?.trim() || thread.gitBranch?.trim();
  const detachedAheadCount = gitWorking?.baseAheadCommitCount ?? 0;
  const hasDetachedUnpublishedWork =
    currentBranch === "HEAD" &&
    unpushedCount > 0 &&
    detachedAheadCount > 0;
  const detachedUnpublishedTooltip = hasDetachedUnpublishedWork
    ? formatDetachedUnpublishedTooltip({
        aheadCount: detachedAheadCount,
        baseBranch: gitWorking?.baseBranch,
        behindCount: gitWorking?.baseBehindCommitCount,
        unpushedCount,
      })
    : "";
  const linkedDirectoryChips = includeLinkedDirectories
    ? thread.linkedDirectories.length > 0
      ? linkedDirectoryMode === "kind"
        ? [
            ...new Map(
              thread.linkedDirectories.map((directory) => [
                directory.kind,
                // Icon-only: the worktree/local distinction is a glyph, not
                // a word (2026-08 density pass — the literal "worktree"
                // pill was the widest fixed chip on every row). The
                // aria-label + copy tooltip still spell it out.
                (
                  <CopyableThreadChip
                    aria-label={
                      directory.kind === "worktree"
                        ? `Copy path for worktree ${directory.label}`
                        : `Copy local path for ${directory.label}`
                    }
                    key={`${thread.id}:${directory.kind}:location-kind`}
                    className="thread-row__chip thread-row__chip--location path-copy-target tooltip-target"
                    value={
                      directory.kind === "worktree"
                        ? directory.worktreePath ?? directory.path
                        : directory.path
                    }
                  >
                    <span aria-hidden="true" className="thread-row__chip-icon">
                      {directory.kind === "worktree" ? (
                        <WorktreeIcon size={12} />
                      ) : (
                        <FolderIcon size={12} />
                      )}
                    </span>
                  </CopyableThreadChip>
                ),
              ]),
            ).values(),
          ]
        : thread.linkedDirectories.map((directory) => {
            const copyPath =
              directory.kind === "worktree"
                ? directory.worktreePath ?? directory.path
                : directory.path;
            return (
              <CopyableThreadChip
                aria-label={
                  directory.kind === "worktree"
                    ? `Copy path for worktree ${directory.label}`
                    : `Copy path for ${directory.label}`
                }
                key={`${thread.id}:${directory.id}:root`}
                className="thread-row__chip path-copy-target tooltip-target"
                value={copyPath}
              >
                <span aria-hidden="true" className="thread-row__chip-icon">
                  {directory.kind === "worktree" ? <WorktreeIcon size={12} /> : <FolderIcon size={12} />}
                </span>
                <span className="thread-row__chip-label">{directory.label}</span>
              </CopyableThreadChip>
            );
          })
      : (
          <span className="thread-row__chip thread-row__chip--muted">
            No linked directory
          </span>
        )
    : null;

  // The instance chip only appears in the main window: a federation window
  // is already branded with its peer's identity, so per-row chips there
  // would be pure noise.
  const instanceChip =
    thread.federation && !hideInstanceChip && !readRendererFederationTarget()
      ? (
          <InstanceChip
            icon={thread.federation.celestialIcon}
            instanceId={
              thread.federation.ref.target.scope === "remote"
                ? thread.federation.ref.target.instanceId
                : ""
            }
            label={thread.federation.instanceLabel}
          />
        )
      : null;

  // Returns a fragment (no wrapping container) so the chips flow as
  // direct siblings inside the row's single .thread-row__chips
  // flex-wrap container, alongside PR / binding / reaction chips.
  return (
    <>
      {instanceChip}

      {showProvider ? (
        <span className="thread-row__chip thread-row__chip--backend">
          {formatBackendLabel(thread.source)}
        </span>
      ) : null}

      {thread.agent ? <AgentThreadChip threadRow /> : null}

      {queuedMessageState === "held" ? (
        <span
          aria-label="A message is held"
          role="img"
          className="thread-row__chip thread-row__chip--held thread-row__chip--persistent thread-row__chip--essential"
          title="A message is held. Open the thread to retry or delete it."
        >
          <PauseIcon size={11} strokeWidth={2.5} />
          Held
        </span>
      ) : queuedMessageState === "scheduled" ? (
        <span
          aria-label="A message is scheduled to send"
          role="img"
          className="thread-row__chip thread-row__chip--scheduled thread-row__chip--persistent"
          title="A message is scheduled to send"
        >
          Scheduled
        </span>
      ) : queuedMessageState === "queued" ? (
        <span
          aria-label="A message is queued to send"
          role="img"
          className="thread-row__chip thread-row__chip--queued thread-row__chip--persistent"
          title="A message is queued to send"
        >
          Queued
        </span>
      ) : null}

      {hasUnsentDraft ? (
        <span
          // Deliberately does NOT contain the word "reply". Playwright's
          // `getByLabel` is a substring match, and 31 specs across 23 files
          // drive the composer with `getByLabel("Reply")` — an
          // "Unsent draft reply" label made every one of them a strict-mode
          // violation the moment a thread had a draft. See "E2E Locator
          // Hygiene Around Global Chrome" in apps/desktop/AGENTS.md.
          aria-label="Unsent draft"
          // Without an explicit role this is a generic element, where
          // `aria-label` is prohibited and silently dropped — the chip would
          // announce as its visible "Draft" text and the fuller label would
          // never be heard. Same reason the pin and terminal markers below
          // carry one.
          role="img"
          className="thread-row__chip thread-row__chip--draft thread-row__chip--persistent"
          data-thread-draft="unsent"
          onMouseEnter={(event) =>
            draftTooltip.show(
              event.currentTarget,
              "Unsent draft\nThis thread has composer text you have not sent.",
            )
          }
          onMouseLeave={draftTooltip.hide}
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            <DraftIcon size={12} />
          </span>
          <span className="thread-row__chip-label">Draft</span>
        </span>
      ) : null}
      {draftTooltip.tooltipNode}

      {leadWait ? (
        <span
          aria-label={`${operatorWaitLabel(leadWait)}: ${leadWait.title}`}
          role={openQuestion ? "button" : "img"}
          tabIndex={openQuestion ? 0 : undefined}
          className={`thread-row__chip thread-row__chip--essential ${
            isBlockingWait(leadWait) ? "thread-row__chip--approval" : "thread-row__chip--question"
          }`}
          data-thread-wait={leadWait.kind}
          onBlur={openQuestion ? waitTooltip.hide : undefined}
          onClick={openQuestion ? openLeadQuestion : undefined}
          onFocus={openQuestion
            ? (event) => waitTooltip.show(event.currentTarget, waitTooltipText())
            : undefined}
          onKeyDown={openQuestion ? (event) => {
            if (event.key === "Enter" || event.key === " ") openLeadQuestion(event);
          } : undefined}
          onMouseEnter={(event) => waitTooltip.show(event.currentTarget, waitTooltipText())}
          onMouseLeave={waitTooltip.hide}
        >
          {operatorWaitLabel(leadWait)}
        </span>
      ) : null}
      {waitTooltip.tooltipNode}

      {openItemCount > 0 ? (
        <span
          aria-label={`${openItemCount} open ${openItemNoun}${openItemCount === 1 ? "" : "s"}${
            unreadItemCount > 0 ? `, ${unreadItemCount} unread` : ""
          }`}
          role="img"
          className={`thread-row__chip thread-row__chip--todos thread-row__chip--persistent${
            unreadItemCount > 0 ? " is-unread" : ""
          }`}
          data-thread-todos={openItemCount}
          data-unread={unreadItemCount > 0 ? unreadItemCount : undefined}
          onMouseEnter={(event) =>
            todoTooltip.show(
              event.currentTarget,
              formatTodoTooltip(
                [...waits.map((wait) => wait.title), ...openTodos.map((todo) => todo.title)],
                openItemNoun,
                unreadItemCount,
              ),
            )
          }
          onMouseLeave={todoTooltip.hide}
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            <TodoIcon size={12} />
          </span>
          <span className="thread-row__chip-label">{openItemCount}</span>
        </span>
      ) : null}
      {todoTooltip.tooltipNode}

      {dependency ? (
        <span
          aria-label={`Continue after: ${dependency.label}`}
          role={openContinueAfter ? "button" : "img"}
          tabIndex={openContinueAfter ? 0 : undefined}
          className={`thread-row__chip thread-row__chip--dependency thread-row__chip--persistent${
            dependency.alert ? " is-alert" : ""
          }`}
          data-thread-dependencies={dependency.count}
          onBlur={dependencyTooltip.hide}
          onClick={openContinueAfter ? (event) => {
            // The row selects its thread on click; the chip opens the dialog instead.
            event.preventDefault();
            event.stopPropagation();
            dependencyTooltip.hide();
            openContinueAfter(thread);
          } : undefined}
          onFocus={(event) => dependencyTooltip.show(event.currentTarget, dependencyTooltipText)}
          onKeyDown={openContinueAfter ? (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            dependencyTooltip.hide();
            openContinueAfter(thread);
          } : undefined}
          onMouseEnter={(event) => dependencyTooltip.show(event.currentTarget, dependencyTooltipText)}
          onMouseLeave={dependencyTooltip.hide}
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            <ContinueAfterIcon size={12} />
          </span>
          <span className="thread-row__chip-label">{dependency.label}</span>
        </span>
      ) : null}
      {dependencyTooltip.tooltipNode}

      {!leadWait && hasApprovalRequest ? (
        <span
          aria-label="Waiting for approval"
          className="thread-row__chip thread-row__chip--approval thread-row__chip--essential"
          title="Waiting for approval"
        >
          Waiting for approval
        </span>
      ) : null}

      {!leadWait && hasInputRequest ? (
        <span
          aria-label="Input needed"
          className="thread-row__chip thread-row__chip--input thread-row__chip--essential"
          title="Input needed"
        >
          Input needed
        </span>
      ) : null}

      {hasIntegratedTerminal ? (
        <span
          aria-label="Integrated terminal running"
          role="img"
          className="thread-row__chip thread-row__chip--terminal"
          onMouseEnter={(event) =>
            terminalTooltip.show(event.currentTarget, "Integrated terminal running")
          }
          onMouseLeave={terminalTooltip.hide}
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            <TerminalIcon size={12} />
          </span>
        </span>
      ) : null}

      {maxLinkedDirectories === undefined || !Array.isArray(linkedDirectoryChips)
        ? linkedDirectoryChips
        : linkedDirectoryChips.slice(0, maxLinkedDirectories)}

      {prChips}

      {branchChip && showBranch ? (
        <CopyableThreadChip
          aria-label={formatBranchCopyLabel({
            branch: branchChip,
            kind: thread.gitBranch ? "expected" : "current",
          })}
          className="thread-row__chip path-copy-target tooltip-target thread-row__chip--mono"
          delayedTooltip
          tooltipText={branchTooltip}
          value={branchChip}
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            <BranchIcon size={12} />
          </span>
          <span className="thread-row__chip-label">{branchChip}</span>
        </CopyableThreadChip>
      ) : null}

      {branchDrifted && thread.observedGitBranch ? (
        <CopyableThreadChip
          aria-label={formatBranchCopyLabel({
            branch: thread.observedGitBranch,
            kind: "current",
          })}
          className="thread-row__chip path-copy-target tooltip-target thread-row__chip--muted thread-row__chip--mono"
          delayedTooltip
          value={thread.observedGitBranch}
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            !
          </span>
          <span className="thread-row__chip-label">now {thread.observedGitBranch}</span>
        </CopyableThreadChip>
      ) : null}

      {hasDirtyState || hasUntracked ? (
        <span
          aria-label={dirtyTooltip.replace(/\n/g, "; ")}
          role="img"
          className="thread-row__chip thread-row__chip--dirty thread-row__chip--mono"
          onMouseEnter={(event) =>
            gitStateTooltip.show(event.currentTarget, dirtyTooltip)
          }
          onMouseLeave={gitStateTooltip.hide}
        >
          {hasDirtyLineStats ? (
            <>
              <span className="thread-row__chip-stat thread-row__chip-stat--added">
                +{gitWorking!.dirtyAdditions.toLocaleString()}
              </span>
              <span className="thread-row__chip-stat thread-row__chip-stat--removed">
                -{gitWorking!.dirtyDeletions.toLocaleString()}
              </span>
            </>
          ) : (
            <span className="thread-row__chip-stat">
              {formatDirtyFileFallback(gitWorking!)}
            </span>
          )}
        </span>
      ) : null}

      {hasDetachedUnpublishedWork ? (
        <span
          aria-label={detachedUnpublishedTooltip}
          role="img"
          className="thread-row__chip thread-row__chip--unpublished thread-row__chip--persistent"
          onMouseEnter={(event) =>
            gitStateTooltip.show(event.currentTarget, detachedUnpublishedTooltip)
          }
          onMouseLeave={gitStateTooltip.hide}
        >
          {unpushedCount.toLocaleString()} unpublished ·{" "}
          {detachedAheadCount.toLocaleString()} ahead
        </span>
      ) : unpushedCount > 0 ? (
        <span
          aria-label={unpushedTooltip}
          role="img"
          className="thread-row__chip thread-row__chip--unpushed thread-row__chip--mono"
          onMouseEnter={(event) =>
            gitStateTooltip.show(event.currentTarget, unpushedTooltip)
          }
          onMouseLeave={gitStateTooltip.hide}
        >
          ↑{unpushedCount.toLocaleString()}
        </span>
      ) : null}
      {gitStateTooltip.tooltipNode}
    </>
  );
}

function formatDirtyFileFallback(
  gitWorking: NonNullable<NavigationThreadSummary["gitWorkingState"]>,
): string {
  if (
    gitWorking.untrackedFiles > 0 &&
    gitWorking.dirtyFiles <= gitWorking.untrackedFiles
  ) {
    return `${gitWorking.untrackedFiles.toLocaleString()} new`;
  }
  return `${gitWorking.dirtyFiles.toLocaleString()} changed`;
}

function formatDetachedUnpublishedTooltip(params: {
  aheadCount: number;
  baseBranch?: string;
  behindCount?: number;
  unpushedCount: number;
}): string {
  const baseBranch = params.baseBranch?.trim();
  const aheadDescription = baseBranch
    ? `HEAD is ${params.aheadCount.toLocaleString()} commit${
        params.aheadCount === 1 ? "" : "s"
      } ahead of ${baseBranch}`
    : `HEAD is ${params.aheadCount.toLocaleString()} commit${
        params.aheadCount === 1 ? "" : "s"
      } ahead of its base`;
  const behindDescription =
    baseBranch && params.behindCount && params.behindCount > 0
      ? ` and ${params.behindCount.toLocaleString()} commit${
          params.behindCount === 1 ? "" : "s"
        } behind`
      : "";

  return `Unpublished detached work: ${params.unpushedCount.toLocaleString()} commit${
    params.unpushedCount === 1 ? "" : "s"
  } not on a remote; ${aheadDescription}${behindDescription}. Create a branch and push it to keep this work.`;
}

function formatBranchCopyLabel(params: {
  branch: string;
  kind: "current" | "expected";
}): string {
  const branchKind = params.kind === "current" ? "current branch" : "branch";
  return `Copy ${branchKind} ${params.branch}`;
}

function formatCommit(value: string | undefined): string | undefined {
  const commit = value?.trim();
  return commit ? commit.slice(0, 12) : undefined;
}

function formatCommitCount(value: number | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return `${label}: ${value.toLocaleString()} commit${value === 1 ? "" : "s"}`;
}

function formatBranchTooltip(
  branch: string,
  gitWorking: NavigationThreadSummary["gitWorkingState"],
): string {
  if (!gitWorking?.baseBranch) {
    return branch;
  }
  const baseCommit = formatCommit(gitWorking.baseCommit);
  const baseTipCommit = formatCommit(gitWorking.baseTipCommit);

  return [
    branch,
    `Base: ${gitWorking.baseBranch}`,
    baseCommit ? `Base commit: ${baseCommit}` : undefined,
    baseTipCommit ? `Base tip: ${baseTipCommit}` : undefined,
    formatCommitCount(gitWorking.baseBehindCommitCount, "Behind base"),
    formatCommitCount(gitWorking.baseAheadCommitCount, "Ahead of base"),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Shared with the transcript's review provenance row, which copies a review's
 * workspace path from the same primitive so both surfaces behave identically.
 */
export function CopyableThreadChip(props: {
  "aria-label": string;
  children: ReactNode;
  className: string;
  delayedTooltip?: boolean;
  tooltipText?: string;
  value: string;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const [copied, setCopied] = useState(false);
  const tooltipBody = props.tooltipText ?? props.value;
  const tooltipText = copied ? "Copied" : `${tooltipBody}\nClick to copy to clipboard`;
  const latestTooltipTextRef = useRef(tooltipText);
  latestTooltipTextRef.current = tooltipText;
  const updateTooltip = tooltip.update;
  const tooltipVisible = tooltip.visible;

  // Hovering the branch chip asks for a Git refresh, so its base drift can
  // change while the tooltip is open. Push a changed body into the open
  // tooltip; an unchanged one leaves it alone. Tracking the body while hidden
  // keeps the next hover from pushing a stale one, as PrChip does.
  const pushedTooltipBodyRef = useRef(tooltipBody);
  useEffect(() => {
    const moved = pushedTooltipBodyRef.current !== tooltipBody;
    pushedTooltipBodyRef.current = tooltipBody;
    if (!moved || !tooltipVisible || copied) {
      return;
    }
    updateTooltip(`${tooltipBody}\nClick to copy to clipboard`);
  }, [copied, tooltipBody, tooltipVisible, updateTooltip]);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeoutId = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const copy = (target: HTMLElement): void => {
    void copyText(props.value).then(() => {
      setCopied(true);
      tooltip.show(target, "Copied");
    });
  };

  return (
    <>
      <span
        aria-label={props["aria-label"]}
        className={props.className}
        role="button"
        tabIndex={0}
        onBlur={tooltip.hide}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          copy(event.currentTarget);
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          copy(event.currentTarget);
        }}
        // A delayed tooltip reads its text when the delay fires.
        onMouseEnter={(event) =>
          props.delayedTooltip
            ? tooltip.showAfterDelay(
              event.currentTarget,
              () => latestTooltipTextRef.current,
            )
            : tooltip.show(event.currentTarget, tooltipText)
        }
        onMouseLeave={tooltip.hide}
      >
        {props.children}
      </span>
      {tooltip.tooltipNode}
    </>
  );
}

function formatTodoTooltip(titles: string[], noun: string, unread: number): string {
  const shown = titles.slice(0, 3).map((title) => `• ${title}`);
  const more = titles.length - shown.length;
  const count = `${titles.length} open ${noun}${titles.length === 1 ? "" : "s"}`;
  return [
    unread > 0 ? `${count}, ${unread} unread` : count,
    ...shown,
    ...(more > 0 ? [`and ${more} more`] : []),
  ].join("\n");
}

function formatWaitTooltip(waits: readonly OperatorWait[]): string {
  const shown = waits.slice(0, 3).map((wait) => `• ${operatorWaitLabel(wait)}: ${wait.title}`);
  const more = waits.length - shown.length;
  return [
    waits.some(isBlockingWait) ? "Waiting on you" : "Asked you",
    ...shown,
    ...(more > 0 ? [`and ${more} more`] : []),
  ].join("\n");
}
