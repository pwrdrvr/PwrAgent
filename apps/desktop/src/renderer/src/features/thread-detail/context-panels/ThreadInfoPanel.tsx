import { useEffect, useState } from "react";
import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import { FolderIcon, WorktreeIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import { formatBackendLabel } from "../../../lib/backend-label";
import { formatExecutionModeLabel } from "../../../lib/execution-mode";
import {
  CopyValueButton,
  TooltipValue,
  findSnapshotForWorktree,
  formatAgentInstructionSummary,
  formatTimestamp,
  handleCopyPath,
  pathBaseName,
  type HideRailTooltip,
  type ShowRailTooltip,
} from "./context-rail-shared";

type ThreadInfoPanelProps = {
  thread: NavigationThreadSummary;
  backends: BackendSummary[];
  platform?: string;
  desktopApi?: DesktopApi;
  worktreeArchiveError?: string;
  onRefreshNavigation?: () => Promise<void>;
  onRestoreWorktree?: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string,
  ) => Promise<void>;
  showTooltip: ShowRailTooltip;
  hideTooltip: HideRailTooltip;
};

/**
 * Thread Info tab — the thread-scoped surfaces: linked directories,
 * the Agent marker, archived worktree snapshots, and the execution
 * context grid. Owns its own Agent-save state; tooltip portal state is
 * owned by the rail and threaded in via `showTooltip` / `hideTooltip`.
 */
export function ThreadInfoPanel(props: ThreadInfoPanelProps) {
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentError, setAgentError] = useState<string>();

  useEffect(() => {
    setAgentError(undefined);
    setAgentSaving(false);
  }, [props.thread.id, props.thread.source]);

  const setThreadAgent = async (agent: { name: string } | null): Promise<void> => {
    if (!props.desktopApi?.setThreadAgent) {
      return;
    }
    setAgentSaving(true);
    setAgentError(undefined);
    try {
      await props.desktopApi.setThreadAgent({
        backend: props.thread.source,
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
      <section className="context-panel__section">
        <h3>Linked directories</h3>
        {props.thread.linkedDirectories.length > 0 ? (
          <ul className="context-list">
            {props.thread.linkedDirectories.map((directory) => {
              const worktreePath = directory.worktreePath ?? directory.path;
              const snapshot = findSnapshotForWorktree(
                props.thread.worktreeSnapshots,
                worktreePath,
              );
              const canRestore =
                directory.kind === "worktree" &&
                snapshot?.state === "archived" &&
                Boolean(props.onRestoreWorktree);

              return (
                <li key={directory.id} className="context-list__item">
                  <div className="context-list__label">
                    <CopyValueButton
                      label={`Copy path for ${directory.label}`}
                      value={directory.path}
                      onBlur={props.hideTooltip}
                      onCopy={handleCopyPath}
                      onShowTooltip={props.showTooltip}
                    />
                    <TooltipValue
                      label={`Path for ${directory.label}`}
                      value={directory.path}
                      onBlur={props.hideTooltip}
                      onShowTooltip={props.showTooltip}
                    >
                      <span aria-hidden="true" className="context-list__icon">
                        {directory.kind === "worktree" ? (
                          <WorktreeIcon size={14} />
                        ) : (
                          <FolderIcon size={14} />
                        )}
                      </span>
                      {directory.label}
                    </TooltipValue>
                  </div>
                  <div className="context-list__actions">
                    {canRestore && snapshot ? (
                      <button
                        className="context-list__action"
                        type="button"
                        onClick={() => {
                          void props.onRestoreWorktree?.(
                            props.thread,
                            snapshot.snapshotRef,
                            snapshot.worktreePath,
                          );
                        }}
                      >
                        Restore
                      </button>
                    ) : null}
                    <span className="context-list__meta">
                      <CopyValueButton
                        label={`Copy path for ${directory.kind} ${directory.label}`}
                        value={worktreePath}
                        onBlur={props.hideTooltip}
                        onCopy={handleCopyPath}
                        onShowTooltip={props.showTooltip}
                      />
                      <TooltipValue
                        label={`Path for ${
                          snapshot?.state === "archived" ? "archived" : directory.kind
                        } ${directory.label}`}
                        value={worktreePath}
                        onBlur={props.hideTooltip}
                        onShowTooltip={props.showTooltip}
                      >
                        {snapshot?.state === "archived" ? "archived" : directory.kind}
                      </TooltipValue>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : props.thread.projectKey?.trim() ? (
          <>
            <ul className="context-list">
              <li className="context-list__item">
                <div className="context-list__label">
                  <CopyValueButton
                    label="Copy recorded working directory"
                    value={props.thread.projectKey!}
                    onBlur={props.hideTooltip}
                    onCopy={handleCopyPath}
                    onShowTooltip={props.showTooltip}
                  />
                  <TooltipValue
                    label="Recorded working directory path"
                    value={props.thread.projectKey!}
                    onBlur={props.hideTooltip}
                    onShowTooltip={props.showTooltip}
                  >
                    <span aria-hidden="true" className="context-list__icon">
                      <FolderIcon size={14} />
                    </span>
                    {pathBaseName(props.thread.projectKey)}
                  </TooltipValue>
                </div>
                <span className="context-list__meta">
                  <CopyValueButton
                    label="Copy missing working directory path"
                    value={props.thread.projectKey!}
                    onBlur={props.hideTooltip}
                    onCopy={handleCopyPath}
                    onShowTooltip={props.showTooltip}
                  />
                  <TooltipValue
                    label="Missing working directory path"
                    value={props.thread.projectKey!}
                    onBlur={props.hideTooltip}
                    onShowTooltip={props.showTooltip}
                  >
                    missing
                  </TooltipValue>
                </span>
              </li>
            </ul>
            <p className="context-empty">Recorded working directory is no longer available.</p>
          </>
        ) : (
          <p className="context-empty">No linked directory</p>
        )}
        {props.worktreeArchiveError ? (
          <p className="context-empty context-empty--error">
            {props.worktreeArchiveError}
          </p>
        ) : null}
      </section>

      <section className="context-panel__section">
        <h3>Agent</h3>
        {props.thread.agent ? (
          <div className="context-list__item">
            <div className="context-list__content">
              <p className="context-list__label">{props.thread.agent.name}</p>
              <p className="context-list__meta">
                {formatAgentInstructionSummary(props.thread.agent.instructionLineCount)}
              </p>
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
            <p className="context-empty">Ordinary work thread</p>
            <button
              className="context-list__action"
              disabled={agentSaving || !props.desktopApi?.setThreadAgent}
              type="button"
              onClick={() => void setThreadAgent({ name: props.thread.title })}
            >
              Mark as Agent
            </button>
          </div>
        )}
        {agentError ? (
          <p className="context-empty context-empty--error" role="alert">
            {agentError}
          </p>
        ) : null}
      </section>

      {props.thread.worktreeSnapshots?.some(
        (snapshot) => snapshot.state === "archived",
      ) ? (
        <section className="context-panel__section">
          <h3>Worktree snapshots</h3>
          <ul className="context-list">
            {props.thread.worktreeSnapshots
              .filter((snapshot) => snapshot.state === "archived")
              .map((snapshot) => (
                <li key={snapshot.id} className="context-list__item">
                  <button
                    aria-label={`Copy snapshot ref ${snapshot.snapshotRef}`}
                    className="context-list__label path-copy-target"
                    type="button"
                    onBlur={props.hideTooltip}
                    onClick={(event) => {
                      void handleCopyPath(event, snapshot.snapshotRef);
                    }}
                    onFocus={(event) => props.showTooltip(event, snapshot.snapshotRef)}
                    onMouseEnter={(event) => props.showTooltip(event, snapshot.snapshotRef)}
                    onMouseLeave={props.hideTooltip}
                  >
                    <span aria-hidden="true" className="context-list__icon">
                      <WorktreeIcon size={14} />
                    </span>
                    {pathBaseName(snapshot.worktreePath)}
                  </button>
                  <div className="context-list__actions">
                    <button
                      className="context-list__action"
                      type="button"
                      onClick={() => {
                        void props.onRestoreWorktree?.(
                          props.thread,
                          snapshot.snapshotRef,
                          snapshot.worktreePath,
                        );
                      }}
                    >
                      Restore
                    </button>
                    <span className="context-list__meta">
                      {snapshot.archivedAt
                        ? formatTimestamp(snapshot.archivedAt)
                        : "archived"}
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <section className="context-panel__section">
        <h3>Execution context</h3>
        <dl className="context-grid">
          <div>
            <dt>Backend</dt>
            <dd>{formatBackendLabel(props.thread.source, props.backends)}</dd>
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
}
