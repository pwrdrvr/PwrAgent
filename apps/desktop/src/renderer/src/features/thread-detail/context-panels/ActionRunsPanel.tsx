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
      </header>
      <div className="actions-panel__body">
        <BackgroundTerminalsView terminals={props.terminals} error={props.error}
          stopping={props.stopping} onStop={props.onStop} />
        {props.runs.length > 0 ? (
          <div className="actions-panel__group">
            <header className="actions-panel__group-header">
              <div className="actions-panel__group-title">
                <h4>Environment</h4>
                <span className="actions-panel__group-count">{props.runs.length}</span>
              </div>
              {/* The dock moves only these rows, so the toggle sits beside
                  them rather than in the panel header above agent commands. */}
              {props.dock === "sidebar" ? (
                <button type="button" className="env-actions-panel__dock-toggle"
                  onClick={() => props.onDockChange("above")}
                  title="Also show action runs above the composer">
                  Show above composer
                </button>
              ) : null}
            </header>
            <EnvActionRunsView
              environmentName={props.environmentName}
              onDismiss={props.onDismissRun}
              onStop={props.onStopRun}
              placement="sidebar"
              hideHeader
              runs={props.runs}
            />
          </div>
        ) : !commandCount && !props.error ? (
          <div className="env-actions-panel__body">
            <p className="context-empty">No environment actions have run for this thread, and no agent commands are running.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
});
