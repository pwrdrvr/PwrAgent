import type { NavigationPresentedThread } from "../../lib/navigation-loaded-rows";
import { useNavigationSelectedDetail } from "../../lib/useNavigationSelectedDetail";
import { useState } from "react";
import { SubAgentsIcon } from "../../icons";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { useDesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

type NativeSubAgentsDisclosureProps = {
  compact?: boolean;
  /**
   * Set on a group that belongs to a child thread rather than to the tray's
   * parent. It only adds the extra indent that puts the group under the row
   * that owns it.
   */
  nested?: boolean;
  thread: NavigationPresentedThread;
};

/**
 * The parent row's existing disclosure owns all child content. Native Codex
 * workers occupy one child slot, so they do not inflate ordinary thread rows
 * while still remaining reachable from their parent.
 *
 * A child thread's own workers do not count here: they render inside the tray
 * this count opens, under the child row that owns them, so they can never be
 * the reason the tray exists.
 */
export function getSubthreadDisclosureCount(
  thread: NavigationPresentedThread,
  ordinaryChildCount: number,
): number {
  return (thread.ordinaryChildCount ?? ordinaryChildCount) + (thread.nativeSubAgentGroupPresent ?? Boolean(thread.codexNativeSubAgents?.length) ? 1 : 0);
}

/** The ordinary child-section preference remains authoritative. */
export function isSubthreadSectionCollapsed(thread: NavigationPresentedThread): boolean {
  return thread.subthreadsCollapsed === true;
}

export function NativeSubAgentsDisclosure(props: NativeSubAgentsDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  const desktopApi = useDesktopApi();
  const openSubAgentTranscriptWindow = desktopApi?.openSubAgentTranscriptWindow;
  const target = props.thread.federation?.ref.target ?? readRendererFederationTarget();
  const detail = useNavigationSelectedDetail({ desktopApi, federationTarget: target,
    ref: expanded ? { backend: props.thread.source, threadId: props.thread.id,
      ownerInstanceId: target?.scope === "remote" ? target.instanceId : undefined } : undefined });
  const nativeSubAgents = detail.state?.detail?.thread?.codexNativeSubAgents ?? props.thread.codexNativeSubAgents ?? [];
  const count = props.thread.nativeSubAgentCount ?? nativeSubAgents.length;


  if (count === 0 && !props.thread.nativeSubAgentGroupPresent) {
    return null;
  }

  const activeCount = nativeSubAgents.filter(
    (subAgent) => subAgent.threadStatus === "active",
  ).length;

  return (
    <div
      className={`native-subagents${props.compact ? " native-subagents--compact" : ""}${
        props.nested ? " native-subagents--nested" : ""
      }`}
      /* The tray freezes while a pointer rests on its rows. A group sits
         BETWEEN child rows, so without this the freeze releases the moment
         the pointer crosses one on its way down the tray, and the list can
         reorder mid-traverse. */
      data-hover-stable-row="subagents"
      data-subagents-thread={threadSummaryIdentityKey(props.thread)}
      role="listitem"
    >
      <button
        aria-expanded={expanded}
        /* A tray can hold several of these groups — the parent's and one per
           child that spawned workers — so the owning thread has to be in the
           name for the buttons to be tellable apart. */
        aria-label={`${expanded ? "Collapse" : "Expand"} ${count} native Codex sub-agents for ${props.thread.title}`}
        className={`native-subagents__toggle${expanded ? " is-open" : ""}`}
        /* Expanding changes the tray's height, so let the frozen snapshot go,
           the way the sibling sub-thread toggle does. */
        data-hover-stable-release="subagents"
        type="button"
        onClick={() => {
          setExpanded((current) => !current);
        }}
      >
        <span aria-hidden="true" className="native-subagents__chevron" />
        <SubAgentsIcon aria-hidden="true" size={14} />
        <span className="native-subagents__label">Sub-agents</span>
        <span className="native-subagents__count">{count}</span>
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
          {detail.state?.error ? <p role="alert">{detail.state.error}</p> : null}
          {detail.state?.readiness !== "ready" ? <p>Loading sub-agents…</p> : null}
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
                    federationTarget:
                      props.thread.federation?.ref.target
                      ?? readRendererFederationTarget(),
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
