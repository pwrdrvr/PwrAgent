import type { EditGroupCommitState } from "@pwragent/shared";
import { EditedFileGroupList } from "../EditedFileGroupList";
import type { EditedFileGroup } from "../edited-file-groups";
import type { EditedFilesDock } from "./context-tab";

type EditsPanelProps = {
  /** Newest-first accumulated edited-file groups for the open thread. */
  groups: EditedFileGroup[];
  /** Git commit lifecycle per group key, from `useEditCommitStates`. */
  commitStatesByKey?: Record<string, EditGroupCommitState>;
  dock: EditedFilesDock;
  onDockChange: (dock: EditedFilesDock) => void;
};

/**
 * Context-rail Edits tab: the accumulated uncommitted file edits for
 * the open thread, grouped per turn (newest first). Shows the same
 * data as the LiveWorkRail's Edited Files section; the dock toggle
 * controls whether that above-composer copy renders at all.
 */
export function EditsPanel(props: EditsPanelProps) {
  return (
    <section className="context-panel__section">
      <div className="edits-panel__header">
        <h3>Edits</h3>
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
      {props.groups.length > 0 ? (
        <EditedFileGroupList
          groups={props.groups}
          commitStatesByKey={props.commitStatesByKey}
        />
      ) : (
        <p className="context-empty">
          No uncommitted file edits yet. Edits from agent turns accumulate
          here until they are committed.
        </p>
      )}
    </section>
  );
}
