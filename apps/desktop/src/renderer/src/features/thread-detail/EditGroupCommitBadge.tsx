import type { EditGroupCommitState } from "@pwragent/shared";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/**
 * Git lifecycle badge for an accumulated edited-file group, as a single status
 * pill plus a copyable short-SHA chip: uncommitted (the "unread"/active state)
 * → committed (local) → pushed. Pushed implies committed, so "Pushed" REPLACES
 * "Committed" rather than stacking both. A trailing "N ignored" hint flags any
 * gitignored files in the group (never part of a commit). Renders nothing until
 * the commit state resolves, so a freshly committed group doesn't flash
 * "uncommitted" first.
 */
export function EditGroupCommitBadge(props: { state?: EditGroupCommitState }) {
  const { state } = props;
  if (!state) {
    return null;
  }

  const status: { variant: "uncommitted" | "committed" | "pushed"; label: string } =
    !state.committed
      ? { variant: "uncommitted", label: "Uncommitted" }
      : state.pushed === true
        ? { variant: "pushed", label: "Pushed" }
        : { variant: "committed", label: "Committed" };
  const ignoredCount = state.ignoredPaths?.length ?? 0;

  return (
    <span className="edit-commit-badge">
      <span
        className={`edit-commit-badge__status edit-commit-badge__status--${status.variant}`}
      >
        {status.label}
      </span>
      {state.committed && state.commitSha && state.shortSha ? (
        <CommitShaChip sha={state.commitSha} shortSha={state.shortSha} />
      ) : null}
      {ignoredCount > 0 ? (
        <span
          className="edit-commit-badge__ignored"
          title="Files in this group that git ignores — never part of a commit"
        >
          {ignoredCount} ignored
        </span>
      ) : null}
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
