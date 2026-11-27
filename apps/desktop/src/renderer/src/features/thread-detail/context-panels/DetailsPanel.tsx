import { useEffect, useRef, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { EditsIcon, PullRequestIcon, TerminalIcon, ThreadIcon } from "../../../icons";
import type { IconProps } from "../../../icons/icon-types";
import {
  DETAILS_SEGMENT_IDS,
  type DetailsSectionId,
  type DetailsSegmentId,
} from "./context-tab";

export type DetailsSegmentBadge = {
  /** Drawn in the segment; absent or zero draws none. */
  count?: number;
  /** What the count means, for the segment's accessible name. */
  description?: string;
};

const SEGMENT_LABELS: Record<DetailsSegmentId, string> = {
  thread: "Thread",
  changes: "Changes",
  prs: "PRs",
  jobs: "Jobs",
};

// Drawn only when the rail is too narrow for the labels; Changes and Jobs
// keep the icons their old spine tabs (Edits, Actions) had.
const SEGMENT_ICONS: Record<DetailsSegmentId, ComponentType<IconProps>> = {
  thread: ThreadIcon,
  changes: EditsIcon,
  prs: PullRequestIcon,
  jobs: TerminalIcon,
};

/**
 * The Details tab: a four-way segmented control over Thread, Changes, PRs
 * and Jobs. It is the rail's only tab strip, and it sits inside the one
 * spine tab. A request that named a section (PR activity, Sub-agents, …)
 * scrolls the segment to it.
 */
export function DetailsPanel(props: {
  segment: DetailsSegmentId;
  section?: DetailsSectionId;
  /** Changes with every reveal, so asking twice for one section scrolls twice. */
  revealKey?: string;
  badges: Partial<Record<DetailsSegmentId, DetailsSegmentBadge>>;
  onSelectSegment: (segment: DetailsSegmentId) => void;
  /** Names a segment on hover and focus, which an icon-only one needs. */
  onShowTooltip?: (target: HTMLElement, text: string) => void;
  onHideTooltip?: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { section, segment, revealKey } = props;
  useEffect(() => {
    if (!section) return;
    const target = panelRef.current?.querySelector<HTMLElement>(`[data-details-section="${section}"]`);
    target?.scrollIntoView?.({ block: "start" });
  }, [revealKey, section, segment]);
  return (
    <div className="details-panel">
      <div
        className="details-segments"
        role="tablist"
        aria-label="Details"
        onKeyDown={handleSegmentKeyDown}
      >
        {DETAILS_SEGMENT_IDS.map((id) => {
          const badge = props.badges[id];
          const count = badge?.count ?? 0;
          const selected = id === segment;
          const Icon = SEGMENT_ICONS[id];
          const tooltip = badge?.description ? `${SEGMENT_LABELS[id]} · ${badge.description}` : SEGMENT_LABELS[id];
          return (
            <button
              key={id}
              id={`details-segment-${id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="details-segment-panel"
              aria-describedby={badge?.description ? `details-segment-${id}-description` : undefined}
              tabIndex={selected ? 0 : -1}
              className={`details-segments__button${selected ? " is-active" : ""}`}
              onClick={() => props.onSelectSegment(id)}
              onMouseEnter={(event) => props.onShowTooltip?.(event.currentTarget, tooltip)}
              onMouseLeave={() => props.onHideTooltip?.()}
              onFocus={(event) => props.onShowTooltip?.(event.currentTarget, tooltip)}
              onBlur={() => props.onHideTooltip?.()}
            >
              <Icon size={14} aria-hidden="true" className="details-segments__icon" />
              {/* Hidden, not removed, when only the icon fits: it stays the
                  tab's name. */}
              <span className="details-segments__label">{SEGMENT_LABELS[id]}</span>
              {count > 0 ? (
                <span className="details-segments__count">
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {/* The tabs' names are their visible text ("PRs 2"), which voice
          control users say; what a count means is each tab's description.
          A hidden node still describes through aria-describedby. */}
      {DETAILS_SEGMENT_IDS.map((id) => {
        const description = props.badges[id]?.description;
        return description ? (
          <span key={id} id={`details-segment-${id}-description`} hidden>
            {description}
          </span>
        ) : null;
      })}
      <div
        ref={panelRef}
        className="details-panel__body"
        id="details-segment-panel"
        role="tabpanel"
        aria-labelledby={`details-segment-${segment}`}
      >
        {props.children}
      </div>
    </div>
  );
}

// Horizontal roving focus. Activation stays manual (Enter, Space or click),
// as on the spine: arrowing across must not write the stored tab each time.
function handleSegmentKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (step === 0 && event.key !== "Home" && event.key !== "End") return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (tabs.length === 0) return;
  const current = tabs.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : current < 0
        ? 0
        : (current + step + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
}
