import { useState } from "react";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadSubAgentCallDetail,
} from "@pwragent/shared";
import { copyText } from "../../lib/copy-text";
import { useDesktopApi } from "../../lib/desktop-api";
import type { ThreadLinkSource } from "../../lib/thread-links";

type TranscriptSubAgentCallProps = {
  detail: AppServerThreadActivityDetail;
  threadLinkSource?: ThreadLinkSource;
};

/**
 * A delegated-agent lifecycle item. This deliberately does not resemble a
 * terminal command: a wait means observing a child agent, not executing
 * `$ wait` in a shell.
 */
export function TranscriptSubAgentCall(props: TranscriptSubAgentCallProps) {
  const [showOutput, setShowOutput] = useState(false);
  const desktopApi = useDesktopApi();
  const openSubAgentTranscriptWindow = desktopApi?.openSubAgentTranscriptWindow;
  const call = props.detail.command?.subAgent;
  if (!call) {
    return null;
  }

  const canOpenTranscript =
    call.origin === "codex-native" && call.backend === "codex";
  const origin = call.origin === "codex-native"
    ? "Codex native agent"
    : "PwrAgent sub-agent";
  const operation = operationLabel(call.operation);
  const status = lifecycleStatus(props.detail.status);
  const output = props.detail.command?.output;

  return (
    <section className="transcript-subagent" aria-label={`${operation} ${origin}`}>
      <header className="transcript-subagent__head">
        <div>
          <p className="transcript-subagent__origin">{origin}</p>
          <h4>{operation}</h4>
        </div>
        {status ? <span className="transcript-subagent__status">{status}</span> : null}
      </header>

      <p className="transcript-subagent__settings">
        {call.model ? <span>Model: <code>{call.model}</code></span> : null}
        {call.reasoningEffort ? <span>Reasoning: {call.reasoningEffort}</span> : null}
        {call.fastMode !== undefined ? <span>Fast mode: {call.fastMode ? "on" : "off"}</span> : null}
      </p>

      <div className="transcript-subagent__agents">
        {call.agents.map((agent) => {
          const agentLabel = agent.name ?? `Agent ${shortAgentId(agent.threadId)}`;
          return (
            <article className="transcript-subagent__agent" key={agent.threadId}>
              <div className="transcript-subagent__agent-head">
                <div>
                  <p className="transcript-subagent__agent-name">{agentLabel}</p>
                  <p className="transcript-subagent__agent-id">{agent.threadId}</p>
                </div>
                {agent.status ? (
                  <span className="transcript-subagent__agent-status">{agent.status}</span>
                ) : null}
              </div>
              {agent.message ? <p className="transcript-subagent__message">{agent.message}</p> : null}
              {canOpenTranscript && openSubAgentTranscriptWindow ? (
                <button
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
            </article>
          );
        })}
      </div>

      <div className="transcript-subagent__actions">
        <button
          className="button button--ghost transcript-subagent__action"
          type="button"
          onClick={() => {
            void copyText(props.detail.command?.displayCommand ?? operation);
          }}
        >
          Copy activity
        </button>
        {output ? (
          <button
            className="button button--ghost transcript-subagent__action"
            type="button"
            aria-expanded={showOutput}
            onClick={() => {
              setShowOutput((current) => !current);
            }}
          >
            {showOutput ? "Hide raw details" : "Show raw details"}
          </button>
        ) : null}
      </div>
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
    default:
      return "Agent activity";
  }
}

function lifecycleStatus(status: AppServerThreadActivityDetail["status"]): string | undefined {
  switch (status) {
    case "in_progress":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return undefined;
  }
}

function shortAgentId(threadId: string): string {
  return threadId.length > 8 ? threadId.slice(0, 8) : threadId;
}
