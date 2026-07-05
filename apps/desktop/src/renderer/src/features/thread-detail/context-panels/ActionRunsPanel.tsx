import type { CodexEnvironmentActionRun } from "@pwragent/shared";
import { EnvActionRunsView } from "../EnvActionRunsView";
import type { ActionRunsDock } from "./context-tab";

type ActionRunsPanelProps = {
  dock: ActionRunsDock;
  environmentName?: string;
  onDockChange: (dock: ActionRunsDock) => void;
  onDismissRun?: (run: CodexEnvironmentActionRun) => void;
  onStopRun?: (
    run: CodexEnvironmentActionRun,
    mode: "stop" | "terminate",
  ) => void;
  runs: CodexEnvironmentActionRun[];
};

export function ActionRunsPanel(props: ActionRunsPanelProps) {
  return (
    <section className="context-panel__section context-panel__section--env-actions">
      {props.runs.length > 0 ? (
        <EnvActionRunsView
          environmentName={props.environmentName}
          onShowAboveComposer={
            props.dock === "sidebar"
              ? () => props.onDockChange("above")
              : undefined
          }
          onDismiss={props.onDismissRun}
          onStop={props.onStopRun}
          placement="sidebar"
          runs={props.runs}
        />
      ) : (
        <>
          <header className="env-actions-panel__header">
            <div className="env-actions-panel__title-group">
              <h3>Actions</h3>
            </div>
          </header>
          <div className="env-actions-panel__body">
            <p className="context-empty">
              No environment actions have run for this thread yet.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
