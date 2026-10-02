import { Fragment, type ReactNode } from "react";
import { EnvActionControlButton, EnvActionStopIcon } from "./EnvActionRunsView";
import type { BackgroundTerminalView } from "../../lib/useCodexBackgroundTerminals";

export type BackgroundTerminalsViewProps = {
  terminals?: BackgroundTerminalView[];
  error?: string;
  stopping?: string;
  onStop?: (terminal: BackgroundTerminalView) => Promise<void>;
};

/**
 * The working directory's last segment. Two worktrees running `pnpm dev`
 * otherwise produce identical collapsed rows, and the operator cannot tell
 * which one to stop without expanding both.
 */
export function agentCommandDirectoryLabel(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? cwd;
}

/** Break opportunities after each separator, so a path wraps at a directory. */
function breakablePath(path: string): ReactNode {
  return path.split(/(?<=[\\/])/).map((part, index) => (
    <Fragment key={index}>{index > 0 ? <wbr /> : null}{part}</Fragment>
  ));
}

export function BackgroundTerminalsView(props: BackgroundTerminalsViewProps) {
  const terminals = props.terminals ?? [];
  if (!terminals.length && !props.error) return null;
  return (
    <div className="actions-panel__group">
      <header className="actions-panel__group-header">
        <div className="actions-panel__group-title">
          <h4>Agent commands</h4>
          <span className="actions-panel__group-count">{terminals.length}</span>
        </div>
      </header>
      {props.error ? <p className="context-empty actions-panel__group-error" role="alert">{props.error}</p> : null}
      <div className="env-action-runs env-action-runs--sidebar">
        {terminals.map((terminal) => {
          const stopping = props.stopping === terminal.processId;
          const usage = [
            terminal.cpuPercent !== undefined ? `CPU ${terminal.cpuPercent.toFixed(1)}%` : undefined,
            terminal.memoryKb !== undefined ? `${(terminal.memoryKb / 1024).toFixed(1)} MiB` : undefined,
          ].filter(Boolean).join(" · ");
          return (
            <details key={terminal.processId}
              className={`composer__queued composer__queued--env-action composer__queued--env-action-running env-action-run env-action-run--sidebar agent-command-run${stopping ? " agent-command-run--stopping" : ""}`}
              aria-label={`Agent command: ${terminal.command}`}>
              <summary className="composer__queued-env-action-summary">
                <span className="composer__queued-env-action-chevron" aria-hidden="true" />
                <span className="status-dot status-dot--active status-dot--blink" aria-hidden="true" />
                <span className="composer__queued-env-action-summary-text">
                  <span className="composer__queued-label">{stopping ? "Stopping" : "Running"}</span>
                  <code className="agent-command-run__command">{terminal.command}</code>
                  <span className="agent-command-run__meta">
                    <span className="agent-command-run__directory" title={terminal.cwd}>
                      {agentCommandDirectoryLabel(terminal.cwd)}
                    </span>
                    {terminal.osPid ? ` · PID ${terminal.osPid}` : null}
                  </span>
                </span>
                <span className="composer__queued-env-action-actions">
                  <EnvActionControlButton className="composer__queued-env-action-stop"
                    disabled={stopping || !props.onStop}
                    ariaLabel={`Stop ${terminal.command}`}
                    tooltip={`Stop ${terminal.command}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void props.onStop?.(terminal);
                    }}>
                    <EnvActionStopIcon />
                  </EnvActionControlButton>
                </span>
              </summary>
              <div className="agent-command-run__body">
                <dl className="agent-command-run__facts">
                  <dt>Directory</dt>
                  <dd className="agent-command-run__path">{breakablePath(terminal.cwd)}</dd>
                  {usage ? (
                    <>
                      <dt>Usage</dt>
                      <dd>{usage}</dd>
                    </>
                  ) : null}
                </dl>
                <div className="agent-command-run__output">
                  <div className="agent-command-run__output-head">
                    <span>Output</span>
                    <span className="agent-command-run__output-scope">since this window opened</span>
                  </div>
                  {terminal.output ? (
                    <pre className="composer__queued-env-action-output"><code>{terminal.output}</code></pre>
                  ) : (
                    <p className="composer__queued-env-action-hint">No output yet.</p>
                  )}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
