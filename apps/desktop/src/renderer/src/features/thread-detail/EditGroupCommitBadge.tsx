import type { EditGroupCommitState } from "@pwragent/shared";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

type CommitBadgeStatus = {
  variant: "uncommitted" | "committed" | "pushed";
  label: string;
  tooltip: string;
};

function resolveStatus(state: EditGroupCommitState): CommitBadgeStatus {
  if (!state.committed) {
    return {
      variant: "uncommitted",
      label: "Uncommitted",
      tooltip:
        "Files in this set have uncommitted changes. Changes may be unrelated to this turn's edits.",
    };
  }

  if (state.pushed === true) {
    return {
      variant: "pushed",
      label: "Pushed",
      tooltip: "Most recent commit touching some files in this set was pushed.",
    };
  }

  return {
    variant: "committed",
    label: "Committed",
    tooltip:
      "Files in this set currently have no uncommitted changes. Verify that changes from this turn were committed.",
  };
}

/**
 * Current worktree-state hint for an edited-file group. Lifecycle status is
 * shown only for the newest group; ignored-file counts stay visible for any
 * resolved group so collapsed historical groups still surface gitignored edits.
 */
export function EditGroupCommitBadge(props: {
  state?: EditGroupCommitState;
  showStatus?: boolean;
}) {
  const { state, showStatus = true } = props;
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  if (!state) {
    return null;
  }

  const status = resolveStatus(state);
  const ignoredCount = state.ignoredPaths?.length ?? 0;
  if (!showStatus && ignoredCount === 0) {
    return null;
  }

  return (
    <span className="edit-commit-badge">
      {showStatus ? (
        <span
          className={`edit-commit-badge__status edit-commit-badge__status--${status.variant}`}
          tabIndex={0}
          aria-label={`${status.label}: ${status.tooltip}`}
          onBlur={tooltip.hide}
          onFocus={(event) => tooltip.show(event.currentTarget, status.tooltip)}
          onMouseEnter={(event) =>
            tooltip.show(event.currentTarget, status.tooltip)
          }
          onMouseLeave={tooltip.hide}
        >
          {status.label}
        </span>
      ) : null}
      {ignoredCount > 0 ? (
        <span
          className="edit-commit-badge__ignored"
          title="Files in this group that git ignores — never part of a commit"
        >
          {ignoredCount} ignored
        </span>
      ) : null}
      {tooltip.tooltipNode}
    </span>
  );
}
