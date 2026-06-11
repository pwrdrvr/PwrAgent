import type { KeyboardEvent, MouseEvent } from "react";
import type { PrSummary } from "@pwragent/shared";

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
  const identity = `${pr.org}/${pr.repo}#${pr.number}`;
  const title = pr.title?.trim();
  const checkState = resolveCheckState(pr);
  const status = prStatusLabel(pr);
  const tooltip = title
    ? `${title}\n${identity} — ${status}`
    : `${identity} — ${status}`;

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
      className={`pr-chip pr-chip--${checkState}`}
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
    </span>
  );
}

function prStatusLabel(pr: PrSummary): string {
  const parts: string[] = [];
  if (pr.lifecycleState === "merged") {
    parts.push("merged");
  } else if (pr.lifecycleState === "closed") {
    parts.push("closed without merge");
  } else if (pr.reviewState === "draft") {
    parts.push("draft");
  } else {
    parts.push("ready for review");
  }

  if (pr.mergeState === "conflicting") {
    parts.push("merge conflict");
  }

  parts.push(checkStateTooltipLabel(resolveCheckState(pr)));
  return parts.join(" · ");
}

function resolveCheckState(pr: PrSummary): NonNullable<PrSummary["checkState"]> {
  return pr.checkState ?? normalizeLegacyCheckState(pr.state);
}

function normalizeLegacyCheckState(state: PrSummary["state"]): NonNullable<PrSummary["checkState"]> {
  if (
    state === "passing"
    || state === "failing"
    || state === "pending"
    || state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

function checkStateTooltipLabel(state: NonNullable<PrSummary["checkState"]>): string {
  switch (state) {
    case "passing":
      return "checks passing";
    case "failing":
      return "checks failing";
    case "pending":
      return "checks pending";
    case "unknown":
      return "status unknown";
  }
}
