import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { PrSummary } from "@pwragent/shared";
import { CloseIcon } from "../../icons";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { PrChipContextMenu } from "./PrChipContextMenu";
import {
  prStatusLabel,
  resolveCheckState,
  resolveChipState,
  resolveLifecycleState,
} from "./pr-chip-state";
import { PrStatusCard, prStatsAccessibleSummary } from "./PrStatusCard";

type PrChipProps = {
  pr: PrSummary;
  /** Render the org/repo prefix when the PR needs repository context. */
  showRepoPrefix: boolean;
  /**
   * Set when the chip is rendered next to explicit status pills (the Pull
   * Requests card). The chip then DEFERS draft + merge-conflict to those
   * pills: the dot stays mirrored to the check state — so it agrees with the
   * sibling "Checks …" pill instead of competing with it — and the draft bar
   * is dropped. Standalone chips (sidebar rows) leave this off and surface
   * draft / conflict on the chip itself, since there are no pills there.
   */
  withStatusPills?: boolean;
  onOpen: (url: string) => void;
  onOpenContextMenu?: (
    pr: PrSummary,
    position: { x: number; y: number; anchorTop?: number },
  ) => void;
  onDetach?: (pr: PrSummary) => void;
};

export function PrChip(props: PrChipProps) {
  const { pr } = props;
  const contextMenuInvokerRef = useRef<HTMLSpanElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{
    x: number;
    y: number;
    anchorTop?: number;
  }>();
  const tooltipController = useViewportTooltip({
    className: "pr-status-card",
  });
  const updateTooltip = tooltipController.update;
  const label = props.showRepoPrefix
    ? `${pr.org}/${pr.repo}#${pr.number}`
    : `#${pr.number}`;
  const chipState = resolveChipState(pr);
  const status = prStatusLabel(pr);
  const stats = prStatsAccessibleSummary(pr);
  const accessibleStatus = stats ? `${status}, ${stats}` : status;
  const card = <PrStatusCard pr={pr} withStatusPills={props.withStatusPills} />;

  // Status updates keep arriving while the pointer rests on a chip, so push
  // fresh numbers into an already-open card instead of freezing it at
  // hover-time values (same behavior the context-window card has).
  //
  // The guard is not optional: a React element is a new object on every render,
  // so feeding one straight into `update` would set state on every render that
  // very update caused. Compare the card's DATA and push only when it moved.
  const cardKey = [
    pr.org,
    pr.repo,
    pr.number,
    pr.title,
    status,
    chipState,
    props.withStatusPills,
    pr.additions,
    pr.deletions,
    pr.changedFiles,
    pr.commitCount,
    pr.createdAt,
    pr.mergedAt,
    pr.closedAt,
  ].join("|");
  const pushedCardKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (pushedCardKeyRef.current === cardKey) {
      return;
    }
    pushedCardKeyRef.current = cardKey;
    updateTooltip(
      <PrStatusCard pr={pr} withStatusPills={props.withStatusPills} />,
    );
  }, [cardKey, pr, props.withStatusPills, updateTooltip]);

  // Draft and merge-conflict ride ALONGSIDE the check-state dot color rather
  // than replacing it: an OPEN draft keeps its real status color and gains a
  // separate affordance bar, and a conflict recolors the dot red (see the
  // `.pr-chip--draft` / `.pr-chip--conflicting` rules in app.css). Both only
  // apply while the PR is open — a merged/closed chip owns its own dot color —
  // and only when the chip is standalone; next to status pills the dot defers
  // to them so it never disagrees with the "Checks …" pill.
  const isOpen = resolveLifecycleState(pr) === "open";
  const surfaceAffordances = isOpen && !props.withStatusPills;
  const isDraft = surfaceAffordances && pr.reviewState === "draft";
  const isConflicting = surfaceAffordances && pr.mergeState === "conflicting";
  const hasFailingChecksStillRunning =
    isOpen
    && resolveCheckState(pr) === "failing"
    && pr.checksStillRunning === true;
  const className = [
    "pr-chip",
    `pr-chip--${chipState}`,
    hasFailingChecksStillRunning ? "pr-chip--checks-running" : "",
    isDraft ? "pr-chip--draft" : "",
    isConflicting ? "pr-chip--conflicting" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // role="button" span (not a real <button>) so the chip is legal HTML
  // inside the row's main <button>. stopPropagation prevents the row's
  // "select thread" click from firing when the user is opening a PR.
  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    tooltipController.hide();
    event.currentTarget.blur();
    props.onOpen(pr.url);
  };
  const handleDetach = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    props.onDetach?.(pr);
  };

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-label={
          `Open ${pr.org}/${pr.repo}#${pr.number} (${accessibleStatus}) in browser`
        }
        className={className}
        data-pr-chip=""
        data-pr-url={pr.url}
        draggable={false}
        onBlur={tooltipController.hide}
        onClick={handleActivate}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          window.getSelection()?.removeAllRanges();
          tooltipController.hide();
          const rect = event.currentTarget.getBoundingClientRect();
          const position = {
            x: event.clientX,
            y: event.clientY,
            anchorTop: rect.top,
          };
          if (props.onOpenContextMenu) {
            props.onOpenContextMenu(pr, position);
          } else {
            contextMenuInvokerRef.current = event.currentTarget;
            setContextMenuPosition(position);
          }
        }}
        onDragStart={(event) => event.preventDefault()}
        onFocus={(event) => tooltipController.show(event.currentTarget, card)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            handleActivate(event);
          }
        }}
        onMouseEnter={(event) => tooltipController.show(event.currentTarget, card)}
        onMouseLeave={tooltipController.hide}
      >
        <span className="pr-chip__dot" aria-hidden="true" />
        <span className="pr-chip__label">{label}</span>
        {props.onDetach ? (
          <span
            aria-label={`Detach ${pr.org}/${pr.repo}#${pr.number} from thread`}
            className="pr-chip__detach"
            role="button"
            tabIndex={0}
            title={`Detach ${pr.org}/${pr.repo}#${pr.number} from thread`}
            onClick={handleDetach}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                handleDetach(event);
              }
            }}
          >
            <CloseIcon size={11} aria-hidden="true" />
          </span>
        ) : null}
        {isDraft ? <span className="pr-chip__draft-bar" aria-hidden="true" /> : null}
      </span>
      {tooltipController.tooltipNode}
      {contextMenuPosition && contextMenuInvokerRef.current ? (
        <PrChipContextMenu
          position={contextMenuPosition}
          pr={pr}
          returnFocusTo={contextMenuInvokerRef.current}
          onClose={() => setContextMenuPosition(undefined)}
        />
      ) : null}
    </>
  );
}

