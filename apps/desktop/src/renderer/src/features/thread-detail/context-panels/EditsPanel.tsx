import { useEffect, useId, useMemo, useState } from "react";
import type {
  AppServerThreadActivityDetail,
  DesktopApplicationDiscoveryCandidate,
  EditGroupCommitState,
  WorktreeOtherChangeEntry,
  WorktreeOtherChangeStatus,
} from "@pwragent/shared";
import { ArrowUpIcon, EditorIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useViewportTooltip } from "../../../lib/useViewportTooltip";
import { DiffStat } from "../DiffStat";
import {
  EditedFileGroupList,
  EditedFileViewToggle,
  type EditedFileGroupView,
} from "../EditedFileGroupList";
import { TranscriptDiff } from "../TranscriptDiff";
import type { EditedFileGroup } from "../edited-file-groups";
import type { EditedFilesDock } from "./context-tab";

type EditsPanelProps = {
  /** Newest-first accumulated edited-file groups for the open thread. */
  groups: EditedFileGroup[];
  /** Git commit lifecycle per group key, from `useEditCommitStates`. */
  commitStatesByKey?: Record<string, EditGroupCommitState>;
  /** Absolute worktree root, for repo-relative paths on expanded file rows. */
  worktreeRoot?: string;
  /** Open an edited file (absolute path) in the editor / OS default. */
  onOpenFile?: (absolutePath: string) => void;
  /** Resolved preferred editor, for the per-row open-in-editor icon. */
  preferredEditor?: DesktopApplicationDiscoveryCandidate;
  /** Scroll the transcript to a group's turn position (timestamp click). */
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  dock: EditedFilesDock;
  onDockChange: (dock: EditedFilesDock) => void;
  desktopApi?: Pick<
    DesktopApi,
    "listWorktreeOtherChanges" | "getWorktreeOtherChangeDiff"
  >;
  workingStateRefreshKey?: string;
};

const OTHER_CHANGES_MAX_FILES = 50;
const OTHER_CHANGE_DIFF_MAX_BYTES = 200_000;

function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function toWorktreeAbsolutePath(
  path: string,
  worktreeRoot?: string,
): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isAbsolutePathLike(trimmed)) {
    return trimmed;
  }
  const root = worktreeRoot?.trim().replace(/[\\/]+$/, "");
  if (!root) {
    return undefined;
  }
  return `${root}/${trimmed.replace(/^[\\/]+/, "")}`;
}

function collectEditedPaths(
  groups: readonly EditedFileGroup[],
  worktreeRoot?: string,
): string[] {
  return [
    ...new Set(
      groups.flatMap((group) =>
        group.details
          .map((detail) => detail.path?.trim())
          .filter((path): path is string => Boolean(path)),
      ),
    ),
  ].flatMap((path) => {
    const absolutePath = toWorktreeAbsolutePath(path, worktreeRoot);
    return absolutePath ? [absolutePath] : [path];
  });
}

function useOtherWorktreeChanges(params: {
  desktopApi?: Pick<DesktopApi, "listWorktreeOtherChanges">;
  worktreeRoot?: string;
  editedPaths: readonly string[];
  refreshKey?: string;
}) {
  const [state, setState] = useState<{
    changes: WorktreeOtherChangeEntry[];
    totalChanges: number;
    truncated: boolean;
    loading: boolean;
  }>({
    changes: [],
    totalChanges: 0,
    truncated: false,
    loading: false,
  });
  const sortedEditedPaths = useMemo(
    () => [...params.editedPaths].sort(),
    [params.editedPaths],
  );
  const editedPathSignature = useMemo(
    () => JSON.stringify(sortedEditedPaths),
    [sortedEditedPaths],
  );

  useEffect(() => {
    const listChanges = params.desktopApi?.listWorktreeOtherChanges;
    const worktreePath = params.worktreeRoot?.trim();
    if (!listChanges || !worktreePath) {
      setState({
        changes: [],
        totalChanges: 0,
        truncated: false,
        loading: false,
      });
      return;
    }

    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    void listChanges({
      worktreePath,
      excludePaths: sortedEditedPaths,
      maxFiles: OTHER_CHANGES_MAX_FILES,
    })
      .then((response) => {
        if (!cancelled) {
          setState({
            changes: response.changes,
            totalChanges: response.totalChanges,
            truncated: response.truncated,
            loading: false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            changes: [],
            totalChanges: 0,
            truncated: false,
            loading: false,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    params.desktopApi?.listWorktreeOtherChanges,
    params.worktreeRoot,
    editedPathSignature,
    sortedEditedPaths,
    params.refreshKey,
  ]);

  return state;
}

function statusAction(status: WorktreeOtherChangeStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "Add";
    case "copied":
      return "Copy";
    case "deleted":
      return "Delete";
    case "modified":
    case "typechange":
      return "Update";
    case "renamed":
      return "Rename";
    default:
      return "Update";
  }
}

function basename(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? repoPath;
}

function otherChangeLabel(change: WorktreeOtherChangeEntry): string {
  return `${statusAction(change.status)} ${basename(change.repoPath)}`;
}

function otherChangesSummary(totalChanges: number): string {
  return `Other ${totalChanges.toLocaleString()} ${
    totalChanges === 1 ? "file" : "files"
  }`;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes.toLocaleString()} B`;
}

function FileSizeStat(props: { bytes: number }) {
  const label = formatByteSize(props.bytes);
  if (!label) {
    return null;
  }
  return (
    <span
      className="diff-stat diff-stat--chip file-size-stat"
      aria-label={label}
    >
      {label}
    </span>
  );
}

/**
 * Context-rail Edits tab: the accumulated uncommitted file edits for
 * the open thread, grouped per turn (newest first). Shows the same
 * data as the LiveWorkRail's Edited Files section; the dock toggle
 * controls whether that above-composer copy renders at all.
 *
 * The panel is a flex column with a FIXED header (title + view toggle +
 * dock toggle) and an internally scrolling body, so the chrome never
 * translates with the list — only the groups scroll, their sticky
 * headers pinning to the body's top edge.
 */
export function EditsPanel(props: EditsPanelProps) {
  const [view, setView] = useState<EditedFileGroupView>("turns");
  const hasGroups = props.groups.length > 0;
  const showViewToggle = props.groups.length > 1;
  const dockTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  // Icon-only toggle (the full label would crowd the header at narrow rail
  // widths): an up arrow that fills with the accent when the edits are also
  // pinned above the composer. Its meaning lives in the custom viewport
  // tooltip + aria-label rather than inline text.
  const dockedAbove = props.dock === "above";
  const dockLabel = dockedAbove ? "Only show here" : "Show above composer";
  const editedPaths = useMemo(
    () => collectEditedPaths(props.groups, props.worktreeRoot),
    [props.groups, props.worktreeRoot],
  );
  const otherChanges = useOtherWorktreeChanges({
    desktopApi: props.desktopApi,
    worktreeRoot: props.worktreeRoot,
    editedPaths,
    refreshKey: props.workingStateRefreshKey,
  });
  const hasOtherChanges = otherChanges.changes.length > 0;

  return (
    <section className="context-panel__section context-panel__section--edits">
      <div className="edits-panel__header">
        <div className="edits-panel__title-group">
          <h3>Edits</h3>
          {showViewToggle ? (
            <EditedFileViewToggle view={view} onViewChange={setView} />
          ) : null}
        </div>
        <button
          type="button"
          className={`edits-panel__dock-toggle${dockedAbove ? " is-active" : ""}`}
          aria-label={dockLabel}
          aria-pressed={dockedAbove}
          onClick={() => {
            dockTooltip.hide();
            props.onDockChange(dockedAbove ? "sidebar" : "above");
          }}
          onMouseEnter={(event) =>
            dockTooltip.show(event.currentTarget, dockLabel)
          }
          onMouseLeave={dockTooltip.hide}
          onFocus={(event) => dockTooltip.show(event.currentTarget, dockLabel)}
          onBlur={dockTooltip.hide}
        >
          <ArrowUpIcon size={16} aria-hidden="true" />
        </button>
        {dockTooltip.tooltipNode}
      </div>
      <div className="edits-panel__body">
        {hasOtherChanges ? (
          <OtherChangesSection
            changes={otherChanges.changes}
            totalChanges={otherChanges.totalChanges}
            truncated={otherChanges.truncated}
            worktreeRoot={props.worktreeRoot}
            desktopApi={props.desktopApi}
            onOpenFile={props.onOpenFile}
          />
        ) : null}
        {hasGroups ? (
          <EditedFileGroupList
            groups={props.groups}
            commitStatesByKey={props.commitStatesByKey}
            view={view}
            worktreeRoot={props.worktreeRoot}
            onOpenFile={props.onOpenFile}
            preferredEditor={props.preferredEditor}
            onScrollToTurn={props.onScrollToTurn}
            showSingleGroupHeader
          />
        ) : !hasOtherChanges && !otherChanges.loading ? (
          <p className="context-empty">
            No uncommitted file edits yet. Edits from agent turns accumulate
            here until they are committed.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function OtherChangesSection(props: {
  changes: WorktreeOtherChangeEntry[];
  totalChanges: number;
  truncated: boolean;
  worktreeRoot?: string;
  desktopApi?: Pick<DesktopApi, "getWorktreeOtherChangeDiff">;
  onOpenFile?: (absolutePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();
  const hiddenCount = Math.max(0, props.totalChanges - props.changes.length);
  const totals = useMemo(
    () =>
      props.changes.reduce(
        (sum, change) => ({
          additions: sum.additions + (change.additions ?? 0),
          removals: sum.removals + (change.removals ?? 0),
        }),
        { additions: 0, removals: 0 },
      ),
    [props.changes],
  );

  return (
    <section className="edited-file-groups__group other-changes">
      <div className="edited-file-groups__group-header other-changes__header">
        <button
          type="button"
          className="edited-file-groups__group-toggle other-changes__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="live-work-rail__chevron" aria-hidden="true" />
          <span className="edited-file-groups__group-summary">
            {otherChangesSummary(props.totalChanges)}
          </span>
        </button>
        <DiffStat
          additions={totals.additions}
          removals={totals.removals}
          className="diff-stat--chip"
        />
      </div>
      <div id={bodyId} hidden={!expanded}>
        {expanded ? (
          <>
            <ul className="live-work-rail__file-list">
              {props.changes.map((change) => (
                <li key={change.path} className="live-work-rail__file-row">
                  <OtherChangeRow
                    change={change}
                    worktreeRoot={props.worktreeRoot}
                    desktopApi={props.desktopApi}
                    onOpenFile={props.onOpenFile}
                  />
                </li>
              ))}
            </ul>
            {props.truncated ? (
              <p className="other-changes__truncated">
                {hiddenCount.toLocaleString()} more not shown.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function OtherChangeRow(props: {
  change: WorktreeOtherChangeEntry;
  worktreeRoot?: string;
  desktopApi?: Pick<DesktopApi, "getWorktreeOtherChangeDiff">;
  onOpenFile?: (absolutePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<
    AppServerThreadActivityDetail | undefined
  >();
  const [loading, setLoading] = useState(false);
  const diffId = useId();
  const canOpen = Boolean(props.onOpenFile);
  const hasStats =
    props.change.additions !== undefined || props.change.removals !== undefined;
  const showSize = !hasStats && props.change.sizeBytes !== undefined;
  const label = otherChangeLabel(props.change);

  useEffect(() => {
    if (!expanded || detail) {
      return;
    }
    const getDiff = props.desktopApi?.getWorktreeOtherChangeDiff;
    const worktreePath = props.worktreeRoot?.trim();
    if (!getDiff || !worktreePath) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getDiff({
      worktreePath,
      path: props.change.path,
      maxBytes: OTHER_CHANGE_DIFF_MAX_BYTES,
    })
      .then((response) => {
        if (!cancelled) {
          setDetail(response.detail);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    detail,
    expanded,
    props.change.path,
    props.desktopApi,
    props.worktreeRoot,
  ]);

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
          <span className="live-work-rail__file-path" title={props.change.path}>
            {label}
          </span>
        </span>
        {hasStats ? (
          <DiffStat
            additions={props.change.additions ?? 0}
            removals={props.change.removals ?? 0}
            className="diff-stat--chip"
          />
        ) : showSize ? (
          <FileSizeStat bytes={props.change.sizeBytes ?? 0} />
        ) : null}
      </button>
      <div id={diffId} className="live-work-rail__file-diff" hidden={!expanded}>
        {expanded ? (
          <>
            <div className="edited-file-row__meta">
              <span className="edited-file-row__path" title={props.change.path}>
                {props.change.repoPath}
              </span>
              {canOpen ? (
                <button
                  type="button"
                  className="edited-file-row__open"
                  onClick={() => props.onOpenFile?.(props.change.path)}
                  aria-label={`Open ${props.change.repoPath} in editor`}
                  title="Open in editor"
                >
                  <EditorIcon className="edited-file-row__open-icon" />
                </button>
              ) : null}
            </div>
            {loading ? (
              <p className="other-changes__loading">Loading diff...</p>
            ) : detail ? (
              <TranscriptDiff detail={detail} compact />
            ) : (
              <p className="other-changes__loading">Diff unavailable.</p>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
