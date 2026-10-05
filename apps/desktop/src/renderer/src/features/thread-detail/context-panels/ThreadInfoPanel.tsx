import { memo, useEffect, useState } from "react";
import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import { formatBackendLabel } from "../../../lib/backend-label";
import { formatExecutionModeLabel } from "../../../lib/execution-mode";
import { ThreadDependenciesPanel } from "./ThreadDependenciesPanel";
import {
  CODEX_AGENT_THREAD_CHANGE_NOTE,
  createDesktopAgentThread,
  formatAgentChangeStatus,
} from "../../../lib/agent-thread";
import {
  CopyValueButton,
  formatAgentInstructionSummary,
  formatTimestamp,
  handleCopyPath,
  type HideRailTooltip,
  type ShowRailTooltip,
} from "./context-rail-shared";

type ThreadInfoPanelProps = {
  thread: NavigationThreadSummary;
  backends: BackendSummary[];
  platform?: string;
  desktopApi?: DesktopApi;
  initialLoadDurationMs?: number;
  onRefreshNavigation?: () => Promise<void>;
  showTooltip: ShowRailTooltip;
  hideTooltip: HideRailTooltip;
};

/**
 * Thread Info tab — the Agent marker and execution context grid. Directory
 * and worktree surfaces live together in the dedicated Linked Projects tab.
 * Owns its own Agent-save state; tooltip portal state is owned by the rail
 * and threaded in via `showTooltip` / `hideTooltip`.
 */
export const ThreadInfoPanel = memo(function ThreadInfoPanel(props: ThreadInfoPanelProps) {
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentError, setAgentError] = useState<string>();

  useEffect(() => {
    setAgentError(undefined);
    setAgentSaving(false);
  }, [props.thread.id, props.thread.source]);

  const setThreadAgent = async (
    agent: { name: string; instructions?: string } | null,
  ): Promise<void> => {
    if (!props.desktopApi?.setThreadAgent) {
      return;
    }
    setAgentSaving(true);
    setAgentError(undefined);
    try {
      await props.desktopApi.setThreadAgent({
        backend: props.thread.source,
        federationTarget: props.thread.federation?.ref.target ?? readRendererFederationTarget(),
        threadId: props.thread.id,
        agent,
      });
      await props.onRefreshNavigation?.();
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgentSaving(false);
    }
  };

  return (
    <>
      <ThreadDependenciesPanel thread={props.thread} desktopApi={props.desktopApi} />
      <section className="context-panel__section">
        <h3>Agent</h3>
        {props.thread.agentChange && !props.thread.agentChange.error ? (
          <div className="context-list__item">
            <p className="context-list__meta" role="status">{formatAgentChangeStatus(props.thread.agentChange)}</p>
            <button className="context-list__action" disabled={agentSaving} type="button"
              onClick={() => void setThreadAgent(props.thread.agent ?? null)}>
              Cancel
            </button>
          </div>
        ) : props.thread.agent ? (
          <div className="context-list__item">
            <div className="context-list__content">
              <p className="context-list__label">{props.thread.agent.name}</p>
              <p className="context-list__meta">
                {formatAgentInstructionSummary(props.thread.agent.instructionLineCount)}
              </p>
              {props.thread.source === "codex" ? (
                <p className="context-list__meta context-list__agent-note">
                  {CODEX_AGENT_THREAD_CHANGE_NOTE}
                </p>
              ) : null}
            </div>
            <button
              className="context-list__action"
              disabled={agentSaving || !props.desktopApi?.setThreadAgent}
              type="button"
              onClick={() => void setThreadAgent(null)}
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="context-list__item">
            <p className="context-empty">
              {props.thread.source === "codex"
                ? CODEX_AGENT_THREAD_CHANGE_NOTE
                : "Ordinary work thread"}
            </p>
            <button
              className="context-list__action"
              disabled={agentSaving || !props.desktopApi?.setThreadAgent}
              type="button"
              onClick={() => void setThreadAgent(createDesktopAgentThread())}
            >
              Mark as Agent
            </button>
          </div>
        )}
        {props.thread.agentChange?.error ? (
          <p className="context-empty context-empty--error" role="alert">
            {formatAgentChangeStatus(props.thread.agentChange)}
          </p>
        ) : null}
        {agentError ? (
          <p className="context-empty context-empty--error" role="alert">
            {agentError}
          </p>
        ) : null}
      </section>

      <section className="context-panel__section">
        <h3>Execution context</h3>
        <dl className="context-grid">
          <div>
            <dt>Backend</dt>
            <dd>{formatBackendLabel(props.thread.source, props.backends)}</dd>
          </div>
          <div>
            <dt>Initial load</dt>
            <dd>
              {typeof props.initialLoadDurationMs === "number"
                ? `${Math.max(0, Math.round(props.initialLoadDurationMs)).toLocaleString()} ms`
                : "Unknown"}
            </dd>
          </div>
          <div>
            <dt>Thread ID</dt>
            <dd className="context-value-row">
              <CopyValueButton
                aria-label="Copy thread id"
                label="Copy thread id"
                maxTooltipLength={48}
                value={props.thread.id}
                onBlur={props.hideTooltip}
                onCopy={handleCopyPath}
                onShowTooltip={props.showTooltip}
              />
              <span className="context-grid__mono">{props.thread.id}</span>
            </dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>{formatExecutionModeLabel(props.thread.executionMode)}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd className="context-value-row">
              {props.thread.gitBranch ? (
                <CopyValueButton
                  label="Copy branch name"
                  value={props.thread.gitBranch}
                  onBlur={props.hideTooltip}
                  onCopy={handleCopyPath}
                  onShowTooltip={props.showTooltip}
                />
              ) : null}
              <span className="context-grid__mono">
                {props.thread.gitBranch ?? "Not attached"}
              </span>
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              {props.thread.createdAt ? formatTimestamp(props.thread.createdAt) : "Unknown"}
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>
              {props.thread.updatedAt ? formatTimestamp(props.thread.updatedAt) : "Unknown"}
            </dd>
          </div>
          <div>
            <dt>Desktop</dt>
            <dd>{props.platform ?? "Unknown"}</dd>
          </div>
        </dl>
      </section>
    </>
  );
});
