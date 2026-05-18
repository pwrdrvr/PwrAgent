import { useId, useState } from "react";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadPlanEntry,
  DesktopApplicationsSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptDiff } from "./TranscriptDiff";
import { TranscriptPlan } from "./TranscriptPlan";

export type LiveWorkRailDock = "above" | "sidebar";

export type LiveWorkRailProps = {
  applications?: DesktopApplicationsSnapshot;
  /**
   * Latest cumulative `item/fileChange/outputDelta` activity that
   * landed in `optimisticEntries`. Surfaces in the Changed Files
   * section when present.
   */
  changedFilesEntry?: AppServerThreadActivityEntry;
  desktopApi?: DesktopApi;
  dock: LiveWorkRailDock;
  /**
   * Cumulative turn diff from `turn/diff/updated`. Renders in the
   * Edited Files section with per-file inline diff expansion.
   */
  editedFilesEntry?: AppServerThreadActivityEntry;
  /**
   * `true` when the rail is showing snapshots from a completed turn
   * (pinned until the next turn starts). `false` while the live turn
   * is still producing entries.
   */
  pinned: boolean;
  planEntry?: AppServerThreadPlanEntry;
  onDockChange: (dock: LiveWorkRailDock) => void;
};

export function LiveWorkRail(props: LiveWorkRailProps) {
  const hasContent = Boolean(
    props.planEntry || props.editedFilesEntry || props.changedFilesEntry,
  );
  const [collapsed, setCollapsed] = useState(false);

  if (!hasContent) {
    return null;
  }

  const dockToggleLabel =
    props.dock === "above" ? "Dock to sidebar" : "Dock above composer";
  const nextDock: LiveWorkRailDock = props.dock === "above" ? "sidebar" : "above";

  return (
    <aside
      className={`live-work-rail live-work-rail--dock-${props.dock}${
        props.pinned ? " live-work-rail--pinned" : ""
      }${collapsed ? " live-work-rail--collapsed" : ""}`}
      role="complementary"
      aria-label={props.pinned ? "Last turn's work" : "Live work"}
    >
      <header className="live-work-rail__header">
        <button
          type="button"
          className="live-work-rail__collapse"
          aria-expanded={!collapsed}
          aria-controls={undefined}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="live-work-rail__chevron" aria-hidden="true" />
          <span className="live-work-rail__title">
            {props.pinned ? "Last turn" : "Live work"}
          </span>
        </button>
        <button
          type="button"
          className="live-work-rail__dock-toggle"
          onClick={() => props.onDockChange(nextDock)}
          aria-label={dockToggleLabel}
          title={dockToggleLabel}
        >
          {props.dock === "above" ? "Sidebar" : "Above"}
        </button>
      </header>

      {!collapsed ? (
        <div className="live-work-rail__body">
          {props.planEntry ? (
            <LiveWorkSection title="Plan">
              <TranscriptPlan
                entry={props.planEntry}
                applications={props.applications}
                desktopApi={props.desktopApi}
              />
            </LiveWorkSection>
          ) : null}

          {props.editedFilesEntry ? (
            <EditedFilesSection entry={props.editedFilesEntry} />
          ) : null}

          {props.changedFilesEntry ? (
            <ChangedFilesSection entry={props.changedFilesEntry} />
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function LiveWorkSection(props: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="live-work-rail__section" aria-label={props.title}>
      {props.children}
    </section>
  );
}

function EditedFilesSection(props: {
  entry: AppServerThreadActivityEntry;
}) {
  const headingId = useId();
  const filesWithDiffs = props.entry.details.filter(
    (detail) => detail.fileDiff,
  );
  const fileCount = filesWithDiffs.length;
  const summaryLabel =
    fileCount > 0
      ? props.entry.summary
      : `${props.entry.summary} (no file details)`;

  return (
    <section
      className="live-work-rail__section live-work-rail__section--edited"
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="live-work-rail__section-heading">
        {summaryLabel}
      </h3>
      {fileCount === 0 ? null : (
        <ul className="live-work-rail__file-list">
          {filesWithDiffs.map((detail) => (
            <li key={detail.id} className="live-work-rail__file-row">
              <EditedFileRow detail={detail} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EditedFileRow(props: {
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
        <span className="live-work-rail__file-stats" aria-label="File diff summary">
          <span className="live-work-rail__file-stat live-work-rail__file-stat--removed">
            -{removals.toLocaleString()}
          </span>
          <span className="live-work-rail__file-stat live-work-rail__file-stat--added">
            +{additions.toLocaleString()}
          </span>
        </span>
      </button>
      {expanded ? (
        <div id={diffId} className="live-work-rail__file-diff">
          <TranscriptDiff detail={props.detail} />
        </div>
      ) : null}
    </>
  );
}

function ChangedFilesSection(props: {
  entry: AppServerThreadActivityEntry;
}) {
  const headingId = useId();
  return (
    <section
      className="live-work-rail__section live-work-rail__section--changed"
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="live-work-rail__section-heading">
        {props.entry.summary}
      </h3>
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

