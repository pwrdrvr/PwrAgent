import type { KeyboardEvent, MouseEvent } from "react";
import type { PrChipState, PrSummary } from "@pwragent/shared";

type PrChipProps = {
  pr: PrSummary;
  /** When the thread spans multiple repos, render the org/repo prefix. */
  showRepoPrefix: boolean;
  onOpen: (url: string) => void;
  onOpenContextMenu?: (
    pr: PrSummary,
    position: { x: number; y: number; anchorTop?: number },
  ) => void;
};

export function PrChip(props: PrChipProps) {
  const { pr } = props;
  const label = props.showRepoPrefix
    ? `${pr.org}/${pr.repo}#${pr.number}`
    : `#${pr.number}`;
  const status = describeStatus(pr);
  const tooltip = `${pr.org}/${pr.repo}#${pr.number} — ${status}`;

  // role="button" span (not a real <button>) so the chip is legal HTML
  // inside the row's main <button>. stopPropagation prevents the row's
  // "select thread" click from firing when the user is opening a PR.
  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    props.onOpen(pr.url);
  };

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Open ${pr.org}/${pr.repo}#${pr.number} (${status}) in browser`}
      title={tooltip}
      className={`pr-chip pr-chip--${pr.state}${pr.isDraft ? " pr-chip--draft" : ""}`}
      onClick={handleActivate}
      onContextMenu={(event) => {
        if (!props.onOpenContextMenu) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        props.onOpenContextMenu(pr, {
          x: event.clientX,
          y: event.clientY,
          anchorTop: rect.top,
        });
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          handleActivate(event);
        }
      }}
    >
      <span className="pr-chip__dot" aria-hidden="true" />
      <span className="pr-chip__label">{label}</span>
      {pr.isDraft ? <span className="pr-chip__draft-bar" aria-hidden="true" /> : null}
    </span>
  );
}

/**
 * Human phrase for the chip's tooltip / aria-label. Draft is orthogonal to the
 * dot color, so it leads the phrase and the check/merge status follows when we
 * actually know it ("draft · all checks passing"); an unknown-status draft
 * collapses to just "draft" rather than "draft · status unknown".
 */
function describeStatus(pr: PrSummary): string {
  const status = statusPhrase(pr.state);
  if (pr.isDraft) {
    return pr.state === "unknown" ? "draft" : `draft · ${status}`;
  }
  return status;
}

function statusPhrase(state: PrChipState): string {
  switch (state) {
    case "merged":
      return "merged";
    case "passing":
      return "all checks passing";
    case "failing":
      return "checks failing";
    case "conflicted":
      return "merge conflict";
    case "pending":
      return "checks pending";
    case "closed":
      return "closed without merge";
    case "unknown":
      return "status unknown";
    // Defensive: overlay rows persisted before this shape may carry a legacy
    // state string (e.g. "draft"); fall back rather than render undefined.
    default:
      return "status unknown";
  }
}
