import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CodexEnvironmentActionRun } from "@pwragent/shared";

const ENV_ACTION_OUTPUT_MAX_LINES = 500;

function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const dropped = lines.length - maxLines;
  return [
    `[…${dropped} earlier lines truncated]`,
    ...lines.slice(-maxLines),
  ].join("\n");
}

type EnvActionOutputChunk = {
  id: number;
  text: string;
};

type EnvActionOutputState = {
  rawOutput: string;
  chunks: EnvActionOutputChunk[];
  nextChunkId: number;
};

function buildEnvActionOutputState(
  output: string,
  nextChunkId = 1,
): EnvActionOutputState {
  const text = tailLines(output, ENV_ACTION_OUTPUT_MAX_LINES);
  return {
    rawOutput: output,
    chunks: text ? [{ id: nextChunkId - 1, text }] : [],
    nextChunkId,
  };
}

function trimEnvActionOutputChunks(
  chunks: EnvActionOutputChunk[],
): EnvActionOutputChunk[] {
  const text = chunks.map((chunk) => chunk.text).join("");
  const trimmed = tailLines(text, ENV_ACTION_OUTPUT_MAX_LINES);
  if (trimmed === text) return chunks;
  return [{ id: chunks.at(-1)?.id ?? 0, text: trimmed }];
}

function elementContainsSelection(element: HTMLElement | null): boolean {
  if (!element) return false;
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (
      element.contains(range.startContainer) ||
      element.contains(range.endContainer)
    ) {
      return true;
    }
  }
  return false;
}

export function formatDurationMs(
  ms?: number,
  options?: { coarseAfterMinute?: boolean },
): string {
  if (!ms || !Number.isFinite(ms)) return "";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (options?.coarseAfterMinute) return `${minutes}m`;
  const remainder = totalSeconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function formatRunningDurationMs(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 1) return "0s";
  return formatDurationMs(totalSeconds * 1_000);
}

export function EnvActionRunsView(props: {
  environmentName?: string;
  runs: CodexEnvironmentActionRun[];
  onDismiss?: (run: CodexEnvironmentActionRun) => void;
  onMoveToSidebar?: () => void;
  onShowAboveComposer?: () => void;
  onStop?: (run: CodexEnvironmentActionRun, mode: "stop" | "terminate") => void;
  placement: "composer" | "sidebar";
}): ReactNode {
  const hasStartedRun = props.runs.some((run) => run.status === "started");
  const [, setElapsedTick] = useState(0);
  useEffect(() => {
    if (!hasStartedRun) return undefined;
    const handle = setInterval(() => {
      setElapsedTick((tick) => tick + 1);
    }, 1_000);
    return () => clearInterval(handle);
  }, [hasStartedRun]);

  if (props.runs.length === 0) return null;

  return (
    <>
      {props.placement === "sidebar" ? (
        <header className="env-actions-panel__header">
          <div className="env-actions-panel__title-group">
            <h3>Actions</h3>
            <span className="env-actions-panel__count">
              {props.runs.length}
            </span>
          </div>
          {props.onShowAboveComposer ? (
            <button
              type="button"
              className="env-actions-panel__dock-toggle"
              onClick={props.onShowAboveComposer}
              title="Also show action runs above the composer"
            >
              Show above composer
            </button>
          ) : null}
        </header>
      ) : null}
      <div
        className={`env-action-runs env-action-runs--${props.placement}`}
      >
        {props.runs.map((run) => (
          <EnvActionRunEntry
            key={run.runId}
            environmentName={props.environmentName}
            onDismiss={props.onDismiss}
            onMoveToSidebar={props.onMoveToSidebar}
            onStop={props.onStop}
            placement={props.placement}
            run={run}
          />
        ))}
      </div>
    </>
  );
}

export function EnvActionRunEntry(props: {
  environmentName?: string;
  onDismiss?: (run: CodexEnvironmentActionRun) => void;
  onMoveToSidebar?: () => void;
  onStop?: (run: CodexEnvironmentActionRun, mode: "stop" | "terminate") => void;
  placement: "composer" | "sidebar";
  run: CodexEnvironmentActionRun;
}): ReactNode {
  const { run } = props;
  const status = run.status;
  const terminationMode = run.terminationMode;
  const label =
    status === "started"
      ? terminationMode
        ? "Env action stopping"
        : "Env action running"
      : terminationMode
        ? "Env action stopped"
        : status === "exited"
          ? "Env action exited"
          : "Env action failed";

  const meta: string[] = [];
  if (run.pid) meta.push(`pid ${run.pid}`);
  if (status === "started" && typeof run.startedAt === "number") {
    meta.push(
      `running for ${formatRunningDurationMs(Date.now() - run.startedAt)}`,
    );
  }
  if (terminationMode && status === "started") {
    meta.push(terminationMode === "terminate" ? "terminating" : "stopping");
  }
  if (status !== "started") {
    if (typeof run.exitCode === "number") {
      meta.push(`exit ${run.exitCode}`);
    } else if (run.exitSignal) {
      meta.push(`signal ${run.exitSignal}`);
    }
    if (run.durationMs) {
      meta.push(`ran ${formatDurationMs(run.durationMs)}`);
    }
  }

  const output = (run.output ?? "").trim();
  const outputLineCount = output
    ? tailLines(output, ENV_ACTION_OUTPUT_MAX_LINES).split("\n").length
    : 0;
  const modifier =
    status === "failed"
      ? "composer__queued--env-action-failed"
      : status === "exited"
        ? "composer__queued--env-action-exited"
        : "composer__queued--env-action-running";
  const stopping = status === "started" && Boolean(terminationMode);

  return (
    <details
      className={`composer__queued composer__queued--env-action ${modifier} env-action-run env-action-run--${props.placement}`}
      aria-label={label}
    >
      <summary className="composer__queued-env-action-summary">
        <span
          className="composer__queued-env-action-chevron"
          aria-hidden="true"
        />
        <span className="composer__queued-env-action-summary-text">
          <span className="composer__queued-label">{label}</span>
          <span className="composer__queued-text">
            {run.actionName}
            {props.environmentName ? ` · ${props.environmentName}` : ""}
            {meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}
          </span>
        </span>
        <span className="composer__queued-env-action-actions">
          {status === "started" ? (
            <>
              <button
                className="composer__secondary-action composer__queued-env-action-control composer__queued-env-action-stop"
                type="button"
                disabled={stopping}
                aria-label="Stop"
                title="Stop gracefully"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onStop?.(run, "stop");
                }}
              >
                <EnvActionStopIcon />
              </button>
              <button
                className="composer__secondary-action composer__queued-env-action-control composer__queued-env-action-terminate"
                type="button"
                disabled={stopping && terminationMode === "terminate"}
                aria-label="Terminate"
                title="Terminate process tree now"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onStop?.(run, "terminate");
                }}
              >
                <EnvActionTerminateIcon />
              </button>
            </>
          ) : (
            <button
              className="composer__secondary-action composer__queued-env-action-dismiss"
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onDismiss?.(run);
              }}
            >
              Dismiss
            </button>
          )}
          {props.placement === "composer" && props.onMoveToSidebar ? (
            <button
              className="composer__secondary-action composer__queued-env-action-control composer__queued-env-action-sidebar"
              type="button"
              aria-label="Move action to the sidebar Actions panel"
              title="Move action to the sidebar Actions panel"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onMoveToSidebar?.();
              }}
            >
              <EnvActionSidebarIcon />
            </button>
          ) : null}
        </span>
      </summary>
      <div className="composer__queued-env-action-body">
        {run.command ? (
          <div className="composer__queued-env-action-section">
            <div className="composer__queued-env-action-section-label">
              Command
            </div>
            <pre className="composer__queued-env-action-command-block">
              <code>$ {run.command}</code>
            </pre>
          </div>
        ) : null}
        <div className="composer__queued-env-action-section">
          <div className="composer__queued-env-action-section-label">
            Output
            {outputLineCount
              ? ` · ${outputLineCount} line${
                  outputLineCount === 1 ? "" : "s"
                }`
              : ""}
          </div>
          <EnvActionOutputBlock output={output} status={status} />
        </div>
      </div>
    </details>
  );
}

function EnvActionStopIcon(): ReactNode {
  return (
    <svg
      className="composer__queued-env-action-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </svg>
  );
}

function EnvActionTerminateIcon(): ReactNode {
  return (
    <svg
      className="composer__queued-env-action-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 3.5h7l5 5v7l-5 5h-7l-5-5v-7z" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
    </svg>
  );
}

function EnvActionSidebarIcon(): ReactNode {
  return (
    <svg
      className="composer__queued-env-action-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M10 5v14" />
      <path d="m15 10 3 2-3 2" />
    </svg>
  );
}

function EnvActionOutputBlock(props: {
  output: string;
  status: CodexEnvironmentActionRun["status"];
}): ReactNode {
  const outputRef = useRef<HTMLPreElement | null>(null);
  const [state, setState] = useState<EnvActionOutputState>(() =>
    buildEnvActionOutputState(props.output),
  );

  useLayoutEffect(() => {
    setState((current) => {
      if (current.rawOutput === props.output) {
        return current;
      }

      if (
        current.rawOutput &&
        props.output.startsWith(current.rawOutput)
      ) {
        const appended = props.output.slice(current.rawOutput.length);
        if (!appended) {
          return { ...current, rawOutput: props.output };
        }
        const nextChunks = [
          ...current.chunks,
          { id: current.nextChunkId, text: appended },
        ];
        return {
          rawOutput: props.output,
          chunks: elementContainsSelection(outputRef.current)
            ? nextChunks
            : trimEnvActionOutputChunks(nextChunks),
          nextChunkId: current.nextChunkId + 1,
        };
      }

      return buildEnvActionOutputState(props.output, current.nextChunkId + 1);
    });
  }, [props.output]);

  const placeholder =
    props.status === "started"
      ? "(no output yet — waiting for the command to print something)"
      : "(no output captured)";

  return (
    <pre className="composer__queued-env-action-output" ref={outputRef}>
      <code>
        {state.chunks.length > 0
          ? state.chunks.map((chunk) => (
              <span key={chunk.id}>{chunk.text}</span>
            ))
          : placeholder}
      </code>
    </pre>
  );
}
