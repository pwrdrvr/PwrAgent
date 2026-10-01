import { BackgroundTerminalsView, type BackgroundTerminalsViewProps } from "../BackgroundTerminalsView";
import { memo } from "react";
import type { CodexEnvironmentActionRun } from "@pwragent/shared";
import { EnvActionRunsView } from "../EnvActionRunsView";
import type { ActionRunsDock } from "./context-tab";

type ActionRunsPanelProps = BackgroundTerminalsViewProps & {
  dock: ActionRunsDock;
  environmentName?: string;
  onDockChange: (dock: ActionRunsDock) => void;
  onDismissRun?: (run: CodexEnvironmentActionRun) => void;
  onStopRun?: (
    run: CodexEnvironmentActionRun,
    mode: "stop" | "terminate"
  ) => void;
  runs: CodexEnvironmentActionRun[];
};

export const ActionRunsPanel = memo(function ActionRunsPanel(props: ActionRunsPanelProps) {
  const commandCount = props.terminals?.length ?? 0;
  const count = props.runs.length + commandCount;
  return (
    <section className="context-panel__section context-panel__section--env-actions">
      <header className="env-actions-panel__header">
        <div className="env-actions-panel__title-group">
          <h3>Actions</h3>
          {count > 0 ? <span className="env-actions-panel__count">{count}</span> : null}
        </div>
        {props.dock === "sidebar" && props.runs.length > 0 ? (
          <button type="button" className="env-actions-panel__dock-toggle"
            onClick={() => props.onDockChange("above")}>
            Show above composer
          </button>
        ) : null}
      </header>
      <div className="actions-panel__body">
        <BackgroundTerminalsView terminals={props.terminals} error={props.error}
          stopping={props.stopping} onStop={props.onStop} />
        {props.runs.length > 0 ? (
          <>
            <header className="env-actions-panel__header">
              <div className="env-actions-panel__title-group"><h3>Environment actions</h3></div>
            </header>
            <EnvActionRunsView
              environmentName={props.environmentName}
              onDismiss={props.onDismissRun}
              onStop={props.onStopRun}
              placement="sidebar"
              hideHeader
              runs={props.runs}
            />
          </>
        ) : !commandCount && !props.error ? (
          <div className="env-actions-panel__body">
            <p className="context-empty">No actions or background commands are running for this thread.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
});
