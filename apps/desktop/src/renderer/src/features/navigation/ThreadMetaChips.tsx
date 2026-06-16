import { useEffect, useState, type ReactNode } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { isBranchDrifted } from "@pwragent/shared";
import { BranchIcon, FolderIcon, PinIcon, WorktreeIcon } from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { copyText } from "../../lib/copy-text";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

type ThreadMetaChipsProps = {
  hasApprovalRequest?: boolean;
  includeLinkedDirectories?: boolean;
  linkedDirectoryMode?: "label" | "kind";
  thread: NavigationThreadSummary;
};

export function ThreadMetaChips({
  hasApprovalRequest = false,
  includeLinkedDirectories = false,
  linkedDirectoryMode = "label",
  thread,
}: ThreadMetaChipsProps) {
  // Hover tooltip for the icon-only pin marker — sighted users get the
  // "Pinned" label without the old text pill; screen readers get it from
  // the marker's role="img" + aria-label. Uses the shared viewport
  // tooltip (not a native `title`) so it escapes the sidebar's clipped
  // scroll region, matching the copyable branch/path chips.
  const pinTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const gitStateTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const branchDrifted = isBranchDrifted(thread.gitBranch, thread.observedGitBranch);
  const branchChip = thread.gitBranch ?? thread.observedGitBranch;
  const gitWorking = thread.gitWorkingState;
  const hasDirtySummary = Boolean(
    gitWorking &&
      (gitWorking.dirtyFiles > 0 ||
        gitWorking.dirtyAdditions > 0 ||
        gitWorking.dirtyDeletions > 0),
  );
  const hasUntracked = Boolean(gitWorking && gitWorking.untrackedFiles > 0);
  const dirtyTooltip = gitWorking
    ? [
        hasDirtySummary
          ? `Uncommitted changes: ${gitWorking.dirtyFiles} file${
              gitWorking.dirtyFiles === 1 ? "" : "s"
            }, +${gitWorking.dirtyAdditions.toLocaleString()}, -${gitWorking.dirtyDeletions.toLocaleString()}`
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
  const linkedDirectoryChips = includeLinkedDirectories
    ? thread.linkedDirectories.length > 0
      ? linkedDirectoryMode === "kind"
        ? [
            ...new Map(
              thread.linkedDirectories.map((directory) => [
                directory.kind,
                (
                  <CopyableThreadChip
                    aria-label={
                      directory.kind === "worktree"
                        ? `Copy path for worktree ${directory.label}`
                        : `Copy local path for ${directory.label}`
                    }
                    key={`${thread.id}:${directory.kind}:location-kind`}
                    className="thread-row__chip path-copy-target tooltip-target thread-row__chip--mono"
                    value={
                      directory.kind === "worktree"
                        ? directory.worktreePath ?? directory.path
                        : directory.path
                    }
                  >
                    {directory.kind}
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

  // Returns a fragment (no wrapping container) so the chips flow as
  // direct siblings inside the row's single .thread-row__chips
  // flex-wrap container, alongside PR / binding / reaction chips.
  return (
    <>
      <span className="thread-row__chip thread-row__chip--backend">
        {formatBackendLabel(thread.source)}
      </span>

      {hasApprovalRequest ? (
        <span
          aria-label="Waiting for approval"
          className="thread-row__chip thread-row__chip--approval"
          title="Waiting for approval"
        >
          Waiting for approval
        </span>
      ) : null}

      {linkedDirectoryChips}

      {thread.pinnedRank && !thread.parentThreadId ? (
        <span
          aria-label="Pinned"
          role="img"
          className="thread-row__chip thread-row__chip--pin"
          onMouseEnter={(event) => pinTooltip.show(event.currentTarget, "Pinned")}
          onMouseLeave={pinTooltip.hide}
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            <PinIcon size={12} />
          </span>
        </span>
      ) : null}
      {pinTooltip.tooltipNode}

      {branchChip ? (
        <CopyableThreadChip
          aria-label={formatBranchCopyLabel({
            branch: branchChip,
            kind: thread.gitBranch ? "expected" : "current",
          })}
          className="thread-row__chip path-copy-target tooltip-target thread-row__chip--mono"
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
          value={thread.observedGitBranch}
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            !
          </span>
          <span className="thread-row__chip-label">now {thread.observedGitBranch}</span>
        </CopyableThreadChip>
      ) : null}

      {hasDirtySummary || hasUntracked ? (
        <span
          aria-label={dirtyTooltip.replace(/\n/g, "; ")}
          role="img"
          className="thread-row__chip thread-row__chip--dirty thread-row__chip--mono"
          onMouseEnter={(event) =>
            gitStateTooltip.show(event.currentTarget, dirtyTooltip)
          }
          onMouseLeave={gitStateTooltip.hide}
        >
          {hasDirtySummary ? (
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
              {gitWorking!.untrackedFiles} new
            </span>
          )}
        </span>
      ) : null}

      {unpushedCount > 0 ? (
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

function formatBranchCopyLabel(params: {
  branch: string;
  kind: "current" | "expected";
}): string {
  const branchKind = params.kind === "current" ? "current branch" : "branch";
  return `Copy ${branchKind} ${params.branch}`;
}

function CopyableThreadChip(props: {
  "aria-label": string;
  children: ReactNode;
  className: string;
  value: string;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const [copied, setCopied] = useState(false);
  const tooltipText = copied ? "Copied" : `${props.value}\nClick to copy to clipboard`;

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
        onMouseEnter={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseLeave={tooltip.hide}
      >
        {props.children}
      </span>
      {tooltip.tooltipNode}
    </>
  );
}
