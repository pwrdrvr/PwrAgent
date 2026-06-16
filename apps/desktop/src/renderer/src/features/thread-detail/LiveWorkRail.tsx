import { useId, useState } from "react";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadPlanEntry,
  DesktopApplicationsSnapshot,
  EditGroupCommitState,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { resolvePreferredEditor } from "../../lib/preferred-application";
import { TranscriptPlan } from "./TranscriptPlan";
import {
  EditedFileGroupList,
  EditedFileViewToggle,
  type EditedFileGroupView,
} from "./EditedFileGroupList";
import {
  summarizeEditedFileGroups,
  type EditedFileGroup,
} from "./edited-file-groups";

export type LiveWorkRailProps = {
  applications?: DesktopApplicationsSnapshot;
  /**
   * Latest cumulative `item/fileChange/outputDelta` activity that
   * landed in `optimisticEntries`. Surfaces in the Changed Files
   * section when present.
   */
  changedFilesEntry?: AppServerThreadActivityEntry;
  desktopApi?: DesktopApi;
  /**
   * Accumulated edited-file groups (newest first) from
   * `collectEditedFileGroups`: the live turn's cumulative diff plus
   * every prior uncommitted turn's edits. Omitted entirely when the
   * user docks edited files to the context-rail Edits panel.
   */
  editedFileGroups?: EditedFileGroup[];
  /** Git commit lifecycle per group key, from `useEditCommitStates`. */
  editedFileCommitStates?: Record<string, EditGroupCommitState>;
  /** Absolute worktree root, for repo-relative paths on expanded file rows. */
  editedFilesWorktreeRoot?: string;
  /** Open an edited file (absolute path) in the editor / OS default. */
  onOpenEditedFile?: (absolutePath: string) => void;
  /** Scroll the transcript to a group's turn position (timestamp click). */
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  /**
   * `true` when the rail is showing snapshots from a completed turn
   * (pinned until the next turn starts). `false` while the live turn
   * is still producing entries.
   */
  pinned: boolean;
  planEntry?: AppServerThreadPlanEntry;
  /**
   * Moves the edited-files list into the context-rail Edits panel
   * (and stops rendering it here). Present only while edited files
   * are docked above the composer.
   */
  onMoveEditedFilesToSidebar?: () => void;
};

export function LiveWorkRail(props: LiveWorkRailProps) {
  const editedFileGroups = props.editedFileGroups ?? [];
  const editedSummary = summarizeEditedFileGroups(editedFileGroups);

  const hasContent = Boolean(
    props.planEntry || editedSummary || props.changedFilesEntry,
  );
  const [collapsed, setCollapsed] = useState(false);
  const [editedView, setEditedView] = useState<EditedFileGroupView>("turns");
  const bodyId = useId();

  if (!hasContent) {
    return null;
  }

  // Title carries the full summary for each present section (e.g.
  // "Edited 2 files, +5, -2 · Changed 1 file") joined by a midline
  // dot so there's no redundant section heading inside the body.
  // Plan delegates to TranscriptPlan's own header rendering — its
  // contribution here is just the word "Plan" since the detail lives
  // inside the section.
  const sectionLabels: string[] = [];
  if (props.planEntry) sectionLabels.push("Plan");
  if (editedSummary) sectionLabels.push(editedSummary);
  if (props.changedFilesEntry) sectionLabels.push(props.changedFilesEntry.summary);
  const railTitle = sectionLabels.join(" · ");
  const railAriaLabel = props.pinned ? `${railTitle} (last turn)` : railTitle;

  return (
    <aside
      className={`live-work-rail${
        props.pinned ? " live-work-rail--pinned" : ""
      }${collapsed ? " live-work-rail--collapsed" : ""}`}
      role="complementary"
      aria-label={railAriaLabel}
    >
      <header className="live-work-rail__header">
        <button
          type="button"
          className="live-work-rail__collapse"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="live-work-rail__chevron" aria-hidden="true" />
          <span className="live-work-rail__title">{railTitle}</span>
        </button>
        <div className="live-work-rail__header-actions">
          {/* The view toggle lives in the fixed header (not the scroll body)
              so it stays put while a long diff scrolls, and reclaims the
              vertical band the inline toggle used to take. Only meaningful
              with more than one turn group, and pointless while collapsed. */}
          {editedFileGroups.length > 1 && !collapsed ? (
            <EditedFileViewToggle
              view={editedView}
              onViewChange={setEditedView}
            />
          ) : null}
          {editedSummary && props.onMoveEditedFilesToSidebar ? (
            <button
              type="button"
              className="live-work-rail__dock-toggle"
              onClick={props.onMoveEditedFilesToSidebar}
              aria-label="Move edited files to the sidebar Edits panel"
              title="Move edited files to the sidebar Edits panel"
            >
              Sidebar
            </button>
          ) : null}
        </div>
      </header>

      {/* Body stays mounted across collapse toggles so the
          `aria-controls` from the header button always points at a
          live element. `hidden` removes it from the accessibility
          tree and from layout (display:none equivalent). */}
      <div id={bodyId} className="live-work-rail__body" hidden={collapsed}>
        {props.planEntry ? (
          <TranscriptPlan
            entry={props.planEntry}
            applications={props.applications}
            desktopApi={props.desktopApi}
          />
        ) : null}

        {editedSummary ? (
          <section className="live-work-rail__section live-work-rail__section--edited">
            <EditedFileGroupList
              groups={editedFileGroups}
              commitStatesByKey={props.editedFileCommitStates}
              view={editedView}
              worktreeRoot={props.editedFilesWorktreeRoot}
              onOpenFile={props.onOpenEditedFile}
              preferredEditor={resolvePreferredEditor(props.applications)}
              onScrollToTurn={props.onScrollToTurn}
            />
          </section>
        ) : null}

        {props.changedFilesEntry ? (
          <ChangedFilesSection entry={props.changedFilesEntry} />
        ) : null}
      </div>
    </aside>
  );
}

function ChangedFilesSection(props: {
  entry: AppServerThreadActivityEntry;
}) {
  // No inner `aria-label` — the rail-level complementary landmark
  // already names the surface with the section summary.
  return (
    <section className="live-work-rail__section live-work-rail__section--changed">
      <ul className="live-work-rail__file-list live-work-rail__file-list--static">
        {props.entry.details.map((detail) => (
          <li
            key={detail.id}
            className="live-work-rail__file-row live-work-rail__file-row--static"
          >
            <span className="live-work-rail__file-path" title={detail.path}>
              {detail.label}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
