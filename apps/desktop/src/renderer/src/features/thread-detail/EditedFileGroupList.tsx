import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type {
  AppServerThreadActivityDetail,
  EditGroupCommitState,
} from "@pwragent/shared";
import { TranscriptDiff } from "./TranscriptDiff";
import { DiffStat } from "./DiffStat";
import { EditGroupCommitBadge } from "./EditGroupCommitBadge";
import {
  flattenEditedFileGroups,
  type EditedFileGroup,
} from "./edited-file-groups";

export type EditedFileGroupView = "turns" | "files";

type EditedFileGroupListProps = {
  /** Newest-first, from `collectEditedFileGroups`. */
  groups: EditedFileGroup[];
  /** Git commit lifecycle per group key, from `useEditCommitStates`. */
  commitStatesByKey?: Record<string, EditGroupCommitState>;
  /**
   * Which view to render. Controlled by the parent so the `By turn / All
   * files` toggle can live in the surface's fixed header (above the scroll
   * region) instead of scrolling with the list. Defaults to `"turns"`; only
   * meaningful with more than one group. Render `<EditedFileViewToggle>` in
   * the header to drive it.
   */
  view?: EditedFileGroupView;
};

const groupTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Accumulated edited files, shared between the LiveWorkRail (above the
 * composer) and the context-rail Edits panel. With multiple turn
 * groups the user can flip between per-turn rounds and the flattened
 * per-file view; a single group renders as a plain file list.
 */
/**
 * Turn-groups shown in the "By turn" view before the rest collapse behind a
 * "Show N more" toggle. Mirrors the directory list's overflow affordance.
 */
const VISIBLE_TURN_GROUPS = 3;

/**
 * The `By turn / All files` segmented control. Rendered by the parent in its
 * fixed header (the context-rail Edits header, the LiveWorkRail card header)
 * so it stays put while the list scrolls beneath it. Only worth showing when
 * there is more than one group.
 */
export function EditedFileViewToggle(props: {
  view: EditedFileGroupView;
  onViewChange: (view: EditedFileGroupView) => void;
}) {
  return (
    <div
      className="edited-file-groups__view-toggle"
      role="group"
      aria-label="Edited files view"
    >
      <button
        type="button"
        className={`edited-file-groups__view-btn${
          props.view === "turns" ? " is-active" : ""
        }`}
        aria-pressed={props.view === "turns"}
        onClick={() => props.onViewChange("turns")}
      >
        By turn
      </button>
      <button
        type="button"
        className={`edited-file-groups__view-btn${
          props.view === "files" ? " is-active" : ""
        }`}
        aria-pressed={props.view === "files"}
        onClick={() => props.onViewChange("files")}
      >
        All files
      </button>
    </div>
  );
}

export function EditedFileGroupList(props: EditedFileGroupListProps) {
  const view = props.view ?? "turns";
  const [showAllTurns, setShowAllTurns] = useState(false);

  if (props.groups.length === 0) {
    return null;
  }

  if (props.groups.length === 1) {
    return <EditedFileList details={props.groups[0].details} />;
  }

  return (
    <div className="edited-file-groups">
      {view === "turns" ? (
        (() => {
          const visibleGroups = showAllTurns
            ? props.groups
            : props.groups.slice(0, VISIBLE_TURN_GROUPS);
          const hiddenCount = props.groups.length - visibleGroups.length;
          return (
            <>
              {visibleGroups.map((group, index) => (
                <EditedFileGroupSection
                  key={group.key}
                  group={group}
                  commitState={props.commitStatesByKey?.[group.key]}
                  defaultExpanded={index === 0}
                />
              ))}
              {props.groups.length > VISIBLE_TURN_GROUPS ? (
                <button
                  type="button"
                  className="edited-file-groups__show-more"
                  aria-expanded={showAllTurns}
                  onClick={() => setShowAllTurns((current) => !current)}
                >
                  {showAllTurns ? "Show less" : `Show ${hiddenCount} more`}
                </button>
              ) : null}
            </>
          );
        })()
      ) : (
        <EditedFileList details={flattenEditedFileGroups(props.groups)} />
      )}
    </div>
  );
}

function formatGroupTimestamp(group: EditedFileGroup): string | undefined {
  const timestamp = group.turn?.completedAt ?? group.turn?.startedAt;
  return typeof timestamp === "number"
    ? groupTimeFormatter.format(timestamp)
    : undefined;
}

/**
 * Live element height via ResizeObserver. Drives the sticky offset for a
 * group's file rows: a fixed pixel estimate gaps or overlaps because the
 * group header height varies (one vs two rows, badge state, summary wrap), so
 * we measure the real header instead.
 */
function useMeasuredHeight(ref: RefObject<HTMLElement | null>): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

function EditedFileGroupSection(props: {
  group: EditedFileGroup;
  commitState?: EditGroupCommitState;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded);
  const bodyId = useId();
  const timestamp = formatGroupTimestamp(props.group);
  // Feed the measured header height to `--edits-group-header-height` so an
  // expanded file's sticky toggle pins flush beneath this group's header
  // rather than at a guessed offset.
  const headerRef = useRef<HTMLDivElement>(null);
  const headerHeight = useMeasuredHeight(headerRef);

  return (
    <section
      className="edited-file-groups__group"
      style={
        headerHeight != null
          ? ({
              "--edits-group-header-height": `${headerHeight}px`,
            } as CSSProperties)
          : undefined
      }
    >
      {/* Flat header: summary / badge / diff-stat / time are siblings so the
          group header can reflow per surface via CSS grid areas — a two-row
          stack in the width-constrained sidebar, a single row (summary + badge
          … stat + time) in the width-rich transcript rail. */}
      <div ref={headerRef} className="edited-file-groups__group-header">
        <button
          type="button"
          className="edited-file-groups__group-toggle"
          aria-controls={bodyId}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="live-work-rail__chevron" aria-hidden="true" />
          <span className="edited-file-groups__group-summary">
            {props.group.summary}
          </span>
        </button>
        <div className="edited-file-groups__group-badge">
          {props.group.live ? (
            <span className="edited-file-groups__group-tag edited-file-groups__group-tag--live">
              This turn
            </span>
          ) : (
            <EditGroupCommitBadge state={props.commitState} />
          )}
        </div>
        <DiffStat
          additions={props.group.additions}
          removals={props.group.removals}
          className="diff-stat--chip"
        />
        {timestamp ? (
          <span className="edited-file-groups__group-time">{timestamp}</span>
        ) : null}
      </div>
      <div id={bodyId} hidden={!expanded}>
        {expanded ? <EditedFileList details={props.group.details} /> : null}
      </div>
    </section>
  );
}

export function EditedFileList(props: {
  details: AppServerThreadActivityDetail[];
}) {
  return (
    <ul className="live-work-rail__file-list">
      {props.details.map((detail) => (
        <li key={detail.id} className="live-work-rail__file-row">
          <EditedFileRow detail={detail} />
        </li>
      ))}
    </ul>
  );
}

export function EditedFileRow(props: {
  detail: AppServerThreadActivityDetail;
}) {
  const [expanded, setExpanded] = useState(false);
  const diffId = useId();
  const additions = props.detail.fileDiff?.additions ?? 0;
  const removals = props.detail.fileDiff?.removals ?? 0;

  return (
    <>
      <button
        type="button"
        className="live-work-rail__file-toggle"
        aria-controls={diffId}
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="live-work-rail__chevron" aria-hidden="true" />
        <span className="live-work-rail__file-path" title={props.detail.path}>
          {props.detail.label}
        </span>
        <DiffStat
          additions={additions}
          removals={removals}
          className="diff-stat--chip"
        />
      </button>
      {/* Diff container stays in the DOM (with `hidden`) so the
          row's `aria-controls={diffId}` always resolves. The
          potentially-heavy TranscriptDiff itself is still
          conditionally mounted to keep the render cost in line
          with what the user actually opens. */}
      <div id={diffId} className="live-work-rail__file-diff" hidden={!expanded}>
        {expanded ? <TranscriptDiff detail={props.detail} compact /> : null}
      </div>
    </>
  );
}
