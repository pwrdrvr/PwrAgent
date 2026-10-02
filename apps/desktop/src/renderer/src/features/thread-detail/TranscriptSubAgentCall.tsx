import { useState } from "react";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadSubAgentCallDetail,
} from "@pwragent/shared";
import { shortSubAgentThreadId } from "@pwragent/shared";
import { useDesktopApi } from "../../lib/desktop-api";
import { RailStatusChip, type RailChipTone } from "./context-panels/RailStatusChip";
import type { ThreadLinkSource } from "../../lib/thread-links";

type TranscriptSubAgentCallProps = {
  detail: AppServerThreadActivityDetail;
  threadLinkSource?: ThreadLinkSource;
};

/**
 * The body of a delegated-agent lifecycle row. This deliberately does not
 * resemble a terminal command: a wait means observing a child agent, not
 * executing `$ wait` in a shell.
 *
 * The row above it already names the event, the worker, and the event's
 * status, and the activity header already has Copy. This body adds only what
 * the row cannot: which worker, on what model, in what state, and the way into
 * its transcript.
 */
export function TranscriptSubAgentCall(props: TranscriptSubAgentCallProps) {
  const [showOutput, setShowOutput] = useState(false);
  const desktopApi = useDesktopApi();
  const openSubAgentTranscriptWindow = desktopApi?.openSubAgentTranscriptWindow;
  const call = props.detail.command?.subAgent;
  if (!call) {
    return null;
  }

  const origin = call.origin === "codex-native"
    ? "Codex sub-agent"
    : "PwrAgent sub-agent";
  const operation = operationLabel(call.operation);
  const output = props.detail.command?.output;
  const settings = [
    call.model,
    call.reasoningEffort,
    call.fastMode ? "Fast" : undefined,
  ].filter((value): value is string => Boolean(value));
  // A spawn or an input carries the worker's state as of that moment, which
  // goes stale the instant the worker moves on. Only an observation of the
  // worker states something the operator can trust.
  const reportsAgentState =
    call.operation === "wait"
    || call.operation === "complete"
    || call.operation === "interrupt"
    || call.operation === "close";

  return (
    <section className="transcript-subagent" aria-label={`${operation} ${origin}`}>
      <ul className="transcript-subagent__agents">
        {call.agents.map((agent) => {
          const agentLabel = agent.name ?? `Agent ${shortSubAgentThreadId(agent.threadId)}`;
          const state = reportsAgentState && agent.status
            ? agentStatePresentation(agent.status)
            : undefined;
          return (
            <li className="transcript-subagent__agent" key={agent.threadId}>
              <div className="transcript-subagent__agent-line">
                <span className="transcript-subagent__agent-name" title={agent.threadId}>
                  {agentLabel}
                </span>
                {settings.length > 0 ? (
                  <span className="transcript-subagent__settings">
                    {settings.join(" · ")}
                  </span>
                ) : null}
                {state ? (
                  <RailStatusChip alert={state.tone === "error"} tone={state.tone}>
                    {state.label}
                  </RailStatusChip>
                ) : null}
                {openSubAgentTranscriptWindow ? (
                  <button
                    aria-label={`Open transcript for ${agentLabel}`}
                    className="button button--ghost transcript-subagent__action"
                    type="button"
                    onClick={() => {
                      void openSubAgentTranscriptWindow({
                        backend: call.backend,
                        ...(props.threadLinkSource
                          ? {
                              federationTarget: {
                                scope: "remote" as const,
                                instanceId: props.threadLinkSource.instanceId,
                              },
                            }
                          : {}),
                        threadId: agent.threadId,
                        title: agentLabel,
                      });
                    }}
                  >
                    Open transcript
                  </button>
                ) : null}
              </div>
              {agent.message ? <p className="transcript-subagent__message">{agent.message}</p> : null}
            </li>
          );
        })}
      </ul>

      {output ? (
        <button
          className="transcript-subagent__raw-toggle"
          type="button"
          aria-expanded={showOutput}
          onClick={() => {
            setShowOutput((current) => !current);
          }}
        >
          {showOutput ? "Hide raw details" : "Show raw details"}
        </button>
      ) : null}
      {showOutput && output ? (
        <pre className="transcript-subagent__output"><code>{output}</code></pre>
      ) : null}
    </section>
  );
}

function operationLabel(operation: AppServerThreadSubAgentCallDetail["operation"]): string {
  switch (operation) {
    case "spawn":
      return "Spawned agent";
    case "wait":
      return "Waited on agent";
    case "send_input":
      return "Sent input to agent";
    case "resume":
      return "Resumed agent";
    case "close":
      return "Closed agent";
    case "complete":
      return "Agent finished";
    case "interrupt":
      return "Interrupted agent";
    default:
      return "Agent activity";
  }
}

/**
 * Codex reports a worker's state as a protocol enum. Say it the way the
 * Sub-agents rail does, never as the raw value.
 */
function agentStatePresentation(
  status: string,
): { label: string; tone: RailChipTone } {
  switch (status) {
    case "pendingInit":
      return { label: "Starting", tone: "neutral" };
    case "running":
      return { label: "Running", tone: "active" };
    case "completed":
      return { label: "Completed", tone: "ok" };
    case "interrupted":
      return { label: "Interrupted", tone: "warning" };
    case "errored":
      return { label: "Failed", tone: "error" };
    case "shutdown":
      return { label: "Closed", tone: "neutral" };
    case "notFound":
      return { label: "Not found", tone: "warning" };
    default:
      return { label: status, tone: "neutral" };
  }
}
