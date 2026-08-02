import { useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { SubAgentsIcon } from "../../icons";
import { useDesktopApi } from "../../lib/desktop-api";

type NativeSubAgentsDisclosureProps = {
  compact?: boolean;
  thread: NavigationThreadSummary;
};

/**
 * The parent row's existing disclosure owns all child content. Native Codex
 * workers occupy one child slot, so they do not inflate ordinary thread rows
 * while still remaining reachable from their parent.
 */
export function getSubthreadDisclosureCount(
  thread: NavigationThreadSummary,
  ordinaryChildCount: number,
): number {
  return ordinaryChildCount + (thread.codexNativeSubAgents?.length ? 1 : 0);
}

/** The ordinary child-section preference remains authoritative. */
export function isSubthreadSectionCollapsed(thread: NavigationThreadSummary): boolean {
  return thread.subthreadsCollapsed === true;
}

export function NativeSubAgentsDisclosure(props: NativeSubAgentsDisclosureProps) {
  const nativeSubAgents = props.thread.codexNativeSubAgents ?? [];
  const [expanded, setExpanded] = useState(false);
  const desktopApi = useDesktopApi();
  const openSubAgentTranscriptWindow = desktopApi?.openSubAgentTranscriptWindow;

  if (nativeSubAgents.length === 0) {
    return null;
  }

  const activeCount = nativeSubAgents.filter(
    (subAgent) => subAgent.threadStatus === "active",
  ).length;

  return (
    <div
      className={`native-subagents${props.compact ? " native-subagents--compact" : ""}`}
      role="listitem"
    >
      <button
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${nativeSubAgents.length} native Codex sub-agents`}
        className={`native-subagents__toggle${expanded ? " is-open" : ""}`}
        type="button"
        onClick={() => {
          setExpanded((current) => !current);
        }}
      >
        <span aria-hidden="true" className="native-subagents__chevron" />
        <SubAgentsIcon aria-hidden="true" size={14} />
        <span className="native-subagents__label">Sub-agents</span>
        <span className="native-subagents__count">{nativeSubAgents.length}</span>
        {activeCount > 0 ? (
          <span className="native-subagents__activity">
            {activeCount} working
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div
          className="native-subagents__list"
          role="list"
          aria-label={`Native Codex sub-agents for ${props.thread.title}`}
        >
          {nativeSubAgents.map((subAgent) => {
            const label = subAgent.agentNickname ?? subAgent.title;
            return (
              <button
                key={subAgent.threadId}
                aria-label={`Open transcript for ${label}`}
                className="native-subagents__agent"
                disabled={!openSubAgentTranscriptWindow}
                title={subAgent.title}
                type="button"
                onClick={() => {
                  if (!openSubAgentTranscriptWindow) {
                    return;
                  }
                  void openSubAgentTranscriptWindow({
                    backend: "codex",
                    threadId: subAgent.threadId,
                    title: label,
                  });
                }}
              >
                {subAgent.threadStatus === "active" ? (
                  <span
                    aria-label="Working"
                    className="native-subagents__status"
                    role="img"
                  />
                ) : null}
                <span className="native-subagents__agent-label">{label}</span>
                {subAgent.agentRole ? (
                  <span className="native-subagents__agent-role">
                    {subAgent.agentRole}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
