import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type {
  AppServerThreadActivityDetail,
  EditGroupCommitState,
} from "@pwragent/shared";
import { EditorIcon } from "../../icons";
import { TranscriptDiff } from "./TranscriptDiff";
import { DiffStat } from "./DiffStat";
import { EditGroupCommitBadge } from "./EditGroupCommitBadge";
import {
  flattenEditedFileGroups,
  type EditedFileGroup,
} from "./edited-file-groups";

export type EditedFileGroupView = "turns" | "files";

/**
 * Per-row config the surface supplies once (worktree root for repo-relative
 * paths, the set of gitignored absolute paths, and an open-in-editor handler)
 * and every `EditedFileRow` reads via context, so it doesn't have to be
 * threaded through the grouped / flattened / single-group render paths.
 */
type EditedFileRowConfig = {
  worktreeRoot?: string;
  ignoredPaths: ReadonlySet<string>;
  onOpenFile?: (absolutePath: string) => void;
};

const EditedFileRowContext = createContext<EditedFileRowConfig>({
  ignoredPaths: new Set<string>(),
});

/** Forward-slash normalize so renderer paths match the main-process set. */
function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Display the path relative to the worktree root, falling back to absolute. */
function toRepoRelativePath(
  absolutePath: string,
  worktreeRoot?: string,
): string {
  if (!worktreeRoot) {
    return absolutePath;
  }
  const root = normalizePath(worktreeRoot).replace(/\/+$/, "");
  const full = normalizePath(absolutePath);
  if (full === root) {
    return absolutePath;
  }
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : absolutePath;
}

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
  /** Absolute worktree root, for showing repo-relative paths on a file row. */
  worktreeRoot?: string;
  /** Open an edited file (absolute path) in the editor / OS default. */
  onOpenFile?: (absolutePath: string) => void;
  /** Scroll the transcript to a group's turn (clickable timestamp). */
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  /**
   * Keep the per-turn group header when there is only one group. The
   * above-composer rail already carries the single-group summary in its outer
   * header, but the sidebar Edits panel needs the group header for timestamp
   * and git lifecycle metadata.
   */
  showSingleGroupHeader?: boolean;
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
 * per-file view. A single group defaults to a plain file list unless the
 * surface needs the group header metadata.
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
  const preserveSingleGroupHeader =
    props.groups.length === 1 && props.showSingleGroupHeader;
  const effectiveView = preserveSingleGroupHeader ? "turns" : view;
  const [showAllTurns, setShowAllTurns] = useState(false);

  // Union of gitignored paths across every resolved group, so a row in any
  // view (grouped / flattened / single) can flag itself as ignored.
  const ignoredPaths = useMemo(() => {
    const set = new Set<string>();
    for (const state of Object.values(props.commitStatesByKey ?? {})) {
      for (const ignored of state.ignoredPaths ?? []) {
        set.add(normalizePath(ignored));
      }
    }
    return set;
  }, [props.commitStatesByKey]);

  const rowConfig = useMemo<EditedFileRowConfig>(
    () => ({
      worktreeRoot: props.worktreeRoot,
      ignoredPaths,
      onOpenFile: props.onOpenFile,
    }),
    [props.worktreeRoot, ignoredPaths, props.onOpenFile],
  );

  if (props.groups.length === 0) {
    return null;
  }

  const content =
    props.groups.length === 1 && !preserveSingleGroupHeader ? (
      <EditedFileList details={props.groups[0].details} />
    ) : (
      <div className="edited-file-groups">{renderGroupedOrFlat()}</div>
    );

  return (
    <EditedFileRowContext.Provider value={rowConfig}>
      {content}
    </EditedFileRowContext.Provider>
  );

  function renderGroupedOrFlat() {
    return effectiveView === "turns" ? (
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
                  onScrollToTurn={props.onScrollToTurn}
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
      );
  }
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
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded);
  const bodyId = useId();
  const timestamp = formatGroupTimestamp(props.group);
  const turnId = props.group.turn?.id;
  const turnTimeMs =
    props.group.turn?.completedAt ?? props.group.turn?.startedAt;
  const canScrollToTurn = Boolean(turnId && props.onScrollToTurn);
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
          canScrollToTurn ? (
            <button
              type="button"
              className="edited-file-groups__group-time edited-file-groups__group-time--link"
              title="Scroll the transcript to this turn"
              aria-label={`Scroll the transcript to this turn (${timestamp})`}
              onClick={() =>
                turnId && props.onScrollToTurn?.(turnId, turnTimeMs)
              }
            >
              {timestamp}
            </button>
          ) : (
            <span className="edited-file-groups__group-time">{timestamp}</span>
          )
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
  const { worktreeRoot, ignoredPaths, onOpenFile } = useContext(
    EditedFileRowContext,
  );
  const absolutePath = props.detail.path;
  const ignored = absolutePath
    ? ignoredPaths.has(normalizePath(absolutePath))
    : false;
  const repoRelativePath = absolutePath
    ? toRepoRelativePath(absolutePath, worktreeRoot)
    : undefined;
  const canOpen = Boolean(absolutePath && onOpenFile);

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
        <span className="live-work-rail__file-label">
          <span className="live-work-rail__file-path" title={props.detail.path}>
            {props.detail.label}
          </span>
          {ignored ? (
            <span
              className="edited-file-row__ignored"
              title="This file is gitignored — it isn't part of any commit"
            >
              Ignored
            </span>
          ) : null}
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
        {expanded ? (
          <>
            {repoRelativePath || canOpen ? (
              <div className="edited-file-row__meta">
                {repoRelativePath ? (
                  <span
                    className="edited-file-row__path"
                    title={props.detail.path}
                  >
                    {repoRelativePath}
                  </span>
                ) : null}
                {canOpen && absolutePath ? (
                  <button
                    type="button"
                    className="edited-file-row__open"
                    onClick={() => onOpenFile?.(absolutePath)}
                    aria-label={`Open ${repoRelativePath ?? props.detail.label} in editor`}
                    title="Open in editor"
                  >
                    <EditorIcon className="edited-file-row__open-icon" />
                  </button>
                ) : null}
              </div>
            ) : null}
            <TranscriptDiff detail={props.detail} compact />
          </>
        ) : null}
      </div>
    </>
  );
}
