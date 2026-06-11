import type { KeyboardEvent, MouseEvent } from "react";
import type { PrSummary } from "@pwragent/shared";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

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
  const tooltipController = useViewportTooltip({
    className: "viewport-tooltip",
  });
  const label = props.showRepoPrefix
    ? `${pr.org}/${pr.repo}#${pr.number}`
    : `#${pr.number}`;
  const identity = `${pr.org}/${pr.repo}#${pr.number}`;
  const title = pr.title?.trim();
  const chipState = resolveChipState(pr);
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
    <>
      <span
        role="button"
        tabIndex={0}
        aria-label={`Open ${pr.org}/${pr.repo}#${pr.number} (${status}) in browser`}
        className={`pr-chip pr-chip--${chipState}`}
        data-pr-chip=""
        onBlur={tooltipController.hide}
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
        onFocus={(event) => tooltipController.show(event.currentTarget, tooltip)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            handleActivate(event);
          }
        }}
        onMouseEnter={(event) => tooltipController.show(event.currentTarget, tooltip)}
        onMouseLeave={tooltipController.hide}
      >
        <span className="pr-chip__dot" aria-hidden="true" />
        <span className="pr-chip__label">{label}</span>
      </span>
      {tooltipController.tooltipNode}
    </>
  );
}

function prStatusLabel(pr: PrSummary): string {
  const lifecycleState = resolveLifecycleState(pr);
  const parts: string[] = [];
  if (lifecycleState === "merged") {
    parts.push("merged");
    return parts.join(" · ");
  } else if (lifecycleState === "closed") {
    parts.push("closed without merge");
    return parts.join(" · ");
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

function resolveChipState(
  pr: PrSummary,
): NonNullable<PrSummary["checkState"]> | "merged" | "closed" {
  const lifecycleState = resolveLifecycleState(pr);
  if (lifecycleState === "merged" || lifecycleState === "closed") {
    return lifecycleState;
  }
  return resolveCheckState(pr);
}

function resolveLifecycleState(pr: PrSummary): NonNullable<PrSummary["lifecycleState"]> {
  if (pr.lifecycleState) {
    return pr.lifecycleState;
  }
  if (pr.state === "merged" || pr.state === "closed") {
    return pr.state;
  }
  return "open";
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
