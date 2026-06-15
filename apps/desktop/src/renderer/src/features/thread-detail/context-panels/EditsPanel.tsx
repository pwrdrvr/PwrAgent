import { useState } from "react";
import type { EditGroupCommitState } from "@pwragent/shared";
import {
  EditedFileGroupList,
  EditedFileViewToggle,
  type EditedFileGroupView,
} from "../EditedFileGroupList";
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
  /** Scroll the transcript to a group's turn position (timestamp click). */
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  dock: EditedFilesDock;
  onDockChange: (dock: EditedFilesDock) => void;
};

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
          className="edits-panel__dock-toggle"
          onClick={() =>
            props.onDockChange(props.dock === "sidebar" ? "above" : "sidebar")
          }
          title={
            props.dock === "sidebar"
              ? "Also show edited files above the composer"
              : "Only show edited files in this panel"
          }
        >
          {props.dock === "sidebar" ? "Show above composer" : "Only show here"}
        </button>
      </div>
      <div className="edits-panel__body">
        {hasGroups ? (
          <EditedFileGroupList
            groups={props.groups}
            commitStatesByKey={props.commitStatesByKey}
            view={view}
            worktreeRoot={props.worktreeRoot}
            onOpenFile={props.onOpenFile}
            onScrollToTurn={props.onScrollToTurn}
          />
        ) : (
          <p className="context-empty">
            No uncommitted file edits yet. Edits from agent turns accumulate
            here until they are committed.
          </p>
        )}
      </div>
    </section>
  );
}
