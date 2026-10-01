import { EnvActionControlButton, EnvActionStopIcon } from "./EnvActionRunsView";
import type { BackgroundTerminalView } from "../../lib/useCodexBackgroundTerminals";

export type BackgroundTerminalsViewProps = {
  terminals?: BackgroundTerminalView[];
  error?: string;
  stopping?: string;
  onStop?: (terminal: BackgroundTerminalView) => Promise<void>;
};

export function BackgroundTerminalsView(props: BackgroundTerminalsViewProps) {
  const terminals = props.terminals ?? [];
  if (!terminals.length && !props.error) return null;
  return (
    <>
      <header className="env-actions-panel__header">
        <div className="env-actions-panel__title-group">
          <h3>Agent commands</h3>
          <span className="env-actions-panel__count">{terminals.length}</span>
        </div>
      </header>
      {props.error ? <p className="context-empty" role="alert">{props.error}</p> : null}
      <div className="env-action-runs env-action-runs--sidebar">
        {terminals.map((terminal) => {
          const stopping = props.stopping === terminal.processId;
          const meta = [
            terminal.osPid ? `PID ${terminal.osPid}` : undefined,
            terminal.cpuPercent !== undefined ? `CPU ${terminal.cpuPercent.toFixed(1)}%` : undefined,
            terminal.memoryKb !== undefined ? `${(terminal.memoryKb / 1024).toFixed(1)} MiB` : undefined,
          ].filter(Boolean).join(" · ");
          return (
            <details key={terminal.processId}
              className="composer__queued composer__queued--env-action composer__queued--env-action-running env-action-run env-action-run--sidebar"
              aria-label={`Agent command: ${terminal.command}`}>
              <summary className="composer__queued-env-action-summary">
                <span className="composer__queued-env-action-chevron" aria-hidden="true" />
                <span className="status-dot status-dot--active status-dot--blink" aria-hidden="true" />
                <span className="composer__queued-env-action-summary-text">
                  <span className="composer__queued-label">{stopping ? "Stopping" : "Running"}</span>
                  <span className="composer__queued-text" title={terminal.command}>{terminal.command}</span>
                </span>
                <span className="composer__queued-env-action-actions">
                  <EnvActionControlButton className="composer__queued-env-action-stop"
                    disabled={stopping || !props.onStop}
                    ariaLabel={`Stop ${terminal.command}`}
                    tooltip="Stop this Codex command"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void props.onStop?.(terminal);
                    }}>
                    <EnvActionStopIcon />
                  </EnvActionControlButton>
                </span>
              </summary>
              <div className="composer__queued-env-action-body">
                <div className="composer__queued-env-action-section">
                  <div className="composer__queued-env-action-section-label">Command</div>
                  <pre className="composer__queued-env-action-command-block"><code>$ {terminal.command}</code></pre>
                </div>
                <div className="composer__queued-env-action-section">
                  <div className="composer__queued-env-action-section-label">Working directory</div>
                  <pre className="composer__queued-env-action-command-block"><code>{terminal.cwd}</code></pre>
                </div>
                {meta ? <div className="composer__queued-env-action-hint">{meta}</div> : null}
                {terminal.output ? (
                  <div className="composer__queued-env-action-section">
                    <div className="composer__queued-env-action-section-label">Recent output captured in this window</div>
                    <pre className="composer__queued-env-action-output"><code>{terminal.output}</code></pre>
                  </div>
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
    </>
  );
}
