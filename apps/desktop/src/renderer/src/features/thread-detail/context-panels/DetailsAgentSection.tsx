import { memo, useCallback, useEffect, useId, useState } from "react";
import type { AgentMemoryArgs } from "@pwragent/shared/contracts/agent-memory";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { AgentMemoryPanel } from "./AgentMemoryPanel";
import { SaveAgentPresetButton } from "./SaveAgentPresetButton";
import type { DesktopApi } from "../../../lib/desktop-api";
import { copyText } from "../../../lib/copy-text";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import { formatOwnerProviderLabel } from "../../../lib/thread-provider-label";
import { formatExecutionModeLabel } from "../../../lib/execution-mode";
import {
  CODEX_AGENT_THREAD_CHANGE_NOTE,
  createDesktopAgentThread,
  formatAgentChangeStatus,
} from "../../../lib/agent-thread";
import { formatAgentInstructionSummary, formatTimestamp } from "./context-rail-shared";
import { DetailsRowMenu, type DetailsRowMenuEntry } from "./DetailsRowMenu";

type DetailsAgentSectionProps = {
  thread: NavigationThreadSummary;
  backends: BackendSummary[];
  platform?: string;
  desktopApi?: DesktopApi;
  initialLoadDurationMs?: number;
  /** This thread's spend, already formatted, when Pricing shows it. */
  cost?: string;
  onOpenToolOutputIncidentExplorer?: () => void;
  onRefreshNavigation?: () => Promise<void>;
  onPortaledInteractionChange?: (open: boolean) => void;
};

/**
 * Details › Thread › Agent: the Agent marker with its memory and preset, a
 * read-only model, access and cost summary, and the execution context behind
 * the section's ⋯, where each fact copies. Owns its own Agent-save state.
 */
export const DetailsAgentSection = memo(function DetailsAgentSection(props: DetailsAgentSectionProps) {
  const headingId = useId();
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentError, setAgentError] = useState<string>();
  const memoryAccess = props.desktopApi?.accessAgentMemory;
  const { id, source, federation } = props.thread;
  const instanceId = federation?.ref.target.scope === "remote" ? federation.ref.target.instanceId : undefined;
  const accessMemory = useCallback(async (operation: AgentMemoryArgs) => {
    if (!memoryAccess) throw new Error("Agent memory is unavailable.");
    return await memoryAccess({
      threadId: id,
      backend: source,
      federationTarget: instanceId ? { scope: "remote", instanceId } : readRendererFederationTarget(),
      operation,
    });
  }, [id, instanceId, memoryAccess, source]);

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

  const model = props.thread.model
    ? `${props.thread.model}${props.thread.reasoningEffort ? ` · ${props.thread.reasoningEffort}` : ""}`
    : undefined;
  const contextEntries = buildExecutionContextEntries(props);

  return (
    <section className="context-panel__section details-section" aria-labelledby={headingId}>
      <div className="details-section__header">
        <h3 id={headingId} className="details-section__heading">Agent</h3>
        <DetailsRowMenu
          label="Execution context"
          entries={contextEntries}
          onOpenChange={props.onPortaledInteractionChange}
        />
      </div>
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
      {memoryAccess && props.thread.agent ? (
        <AgentMemoryPanel key={JSON.stringify([instanceId, source, id])}
          access={accessMemory}
          canEdit={!federation || federation.capabilities?.includes("turn_control") === true} />
      ) : null}
      {props.thread.agent && props.desktopApi && !instanceId && !readRendererFederationTarget() ? (
        <SaveAgentPresetButton key={JSON.stringify([source, id])} thread={props.thread} desktopApi={props.desktopApi} />
      ) : null}
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
      <dl className="details-facts">
        {model ? (
          <div>
            <dt>Model</dt>
            <dd>{model}</dd>
          </div>
        ) : null}
        <div>
          <dt>Access</dt>
          <dd>{formatExecutionModeLabel(props.thread.executionMode)}</dd>
        </div>
        {props.cost ? (
          <div>
            <dt>Cost</dt>
            <dd>{props.cost}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
});

/**
 * The execution context, one copyable row per fact: what the Thread info
 * tab listed, minus Access and Branch, which the section and Folders & git
 * now show where they can be acted on.
 */
function buildExecutionContextEntries(props: DetailsAgentSectionProps): DetailsRowMenuEntry[] {
  const fact = (key: string, label: string, value: string | undefined): DetailsRowMenuEntry => ({
    kind: "item",
    key,
    label,
    detail: value ?? "Unknown",
    disabled: value === undefined,
    onSelect: () => { if (value !== undefined) void copyText(value); },
  });
  const entries: DetailsRowMenuEntry[] = [
    fact("backend", "Backend", formatOwnerProviderLabel(props.thread.source, props.thread.model, props.backends)),
    fact("thread-id", "Thread ID", props.thread.id),
    fact(
      "initial-load",
      "Initial load",
      typeof props.initialLoadDurationMs === "number"
        ? `${Math.max(0, Math.round(props.initialLoadDurationMs)).toLocaleString()} ms`
        : undefined,
    ),
    fact("created", "Created", props.thread.createdAt ? formatTimestamp(props.thread.createdAt) : undefined),
    fact("updated", "Updated", props.thread.updatedAt ? formatTimestamp(props.thread.updatedAt) : undefined),
    fact("desktop", "Desktop", props.platform),
  ];
  if (props.onOpenToolOutputIncidentExplorer) {
    const open = props.onOpenToolOutputIncidentExplorer;
    entries.push({ kind: "separator", key: "incidents-separator" });
    entries.push({ kind: "item", key: "incidents", label: "Tool Output Incidents", onSelect: open });
  }
  return entries;
}
