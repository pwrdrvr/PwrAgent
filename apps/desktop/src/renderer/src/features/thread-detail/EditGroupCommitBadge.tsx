import type { EditGroupCommitState } from "@pwragent/shared";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/**
 * Git lifecycle badge for an accumulated edited-file group: uncommitted
 * (the "unread"/active state) → committed, with a copyable short-SHA chip and
 * a pushed/local indicator. Renders nothing until the commit state resolves,
 * so a freshly committed group doesn't flash "uncommitted" first.
 */
export function EditGroupCommitBadge(props: { state?: EditGroupCommitState }) {
  const { state } = props;
  if (!state) {
    return null;
  }

  if (!state.committed) {
    return (
      <span className="edit-commit-badge edit-commit-badge--uncommitted">
        Uncommitted
      </span>
    );
  }

  return (
    <span className="edit-commit-badge edit-commit-badge--committed">
      <span className="edit-commit-badge__label">Committed</span>
      {state.commitSha && state.shortSha ? (
        <CommitShaChip sha={state.commitSha} shortSha={state.shortSha} />
      ) : null}
      {state.pushed === undefined ? null : (
        <span
          className={`edit-commit-badge__push edit-commit-badge__push--${
            state.pushed ? "pushed" : "local"
          }`}
        >
          {state.pushed ? "Pushed" : "Local"}
        </span>
      )}
    </span>
  );
}

/**
 * Copyable commit-SHA chip. Matches the context rail's own copy affordance
 * (`context-rail-shared`): a viewport tooltip with the full SHA + "Click to
 * copy to clipboard", and click/Enter to copy — copies silently, no "Copied"
 * flip (the thread-row chips flip; the context rail, where this lives, does
 * not — match the surface).
 */
function CommitShaChip(props: { sha: string; shortSha: string }) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const tooltipText = formatCopyTooltip(props.sha);

  const copy = (): void => {
    void copyText(props.sha);
  };

  return (
    <>
      <span
        className="edit-commit-badge__sha"
        role="button"
        tabIndex={0}
        aria-label={`Copy commit ${props.sha}`}
        onBlur={tooltip.hide}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          copy();
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          copy();
        }}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseLeave={tooltip.hide}
      >
        <code className="edit-commit-badge__sha-value">{props.shortSha}</code>
      </span>
      {tooltip.tooltipNode}
    </>
  );
}
