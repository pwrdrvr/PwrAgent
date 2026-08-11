import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  AutomationDetail,
  AutomationReplayCandidate,
  ListAutomationReplayCandidatesResponse,
  MessagingChannelKind,
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import {
  CODEX_AGENT_THREAD_CREATION_NOTE,
  canChangeExistingThreadAgentDesignation,
} from "../../lib/agent-thread";
import { formatBackendLabel } from "../../lib/backend-label";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { ChevronRightIcon, MoreVerticalIcon } from "../../icons";
import { useDismissableMenu } from "../composer/ComposerDropdown";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import {
  formatCostTodayMicros,
  formatAutomationRelative,
  formatAutomationStatus,
  formatBacklogPolicy,
  formatWorkspacePathLabel,
} from "./automation-format";
import {
  AutomationEditor,
  type AutomationEditorSubmit,
} from "./AutomationEditor";
import { AutomationRunHistoryItem } from "./ThreadAutomationsPanel";
import { useAutomationRuns, useAutomations } from "./useAutomations";

type AutomationsScreenProps = {
  desktopApi?: DesktopApi;
  onClose: () => void;
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
  onOpenMessagingSettings?: () => void;
  onRefreshNavigation?: () => Promise<void>;
  onSelectThread?: (thread: NavigationThreadSummary) => void;
  threads: NavigationThreadSummary[];
  directories?: NavigationDirectorySummary[];
};

export function AutomationsScreen(props: AutomationsScreenProps) {
  const automations = useAutomations(props.desktopApi);
  const [editorMode, setEditorMode] = useState<
    | { automation: AutomationDetail; kind: "edit" }
    | { kind: "create" }
    | undefined
  >();
  const [saving, setSaving] = useState(false);
  const [expandedAutomationId, setExpandedAutomationId] = useState<string>();
  const threadsByKey = useMemo(
    () =>
      new Map(
        props.threads.map((thread) => [
          buildThreadIdentityKey(thread.source, thread.id),
          thread,
        ]),
      ),
    [props.threads],
  );

  const submitEditor = async (submission: AutomationEditorSubmit): Promise<void> => {
    setSaving(true);
    try {
      if (submission.kind === "create") {
        await automations.createAutomation(submission.request);
      } else {
        await automations.updateAutomation(submission.request);
      }
      setEditorMode(undefined);
      await props.onRefreshNavigation?.();
    } finally {
      setSaving(false);
    }
  };

  const promoteThreadToAgent = async (thread: NavigationThreadSummary) => {
    if (!canChangeExistingThreadAgentDesignation(thread)) {
      throw new Error(CODEX_AGENT_THREAD_CREATION_NOTE);
    }
    if (!props.desktopApi?.setThreadAgent) {
      throw new Error("Desktop bridge is missing setThreadAgent().");
    }
    const response = await props.desktopApi.setThreadAgent({
      agent: { name: thread.title },
      backend: thread.source,
      threadId: thread.id,
    });
    await props.onRefreshNavigation?.();
    return {
      agent: response.agent,
      backend: response.backend,
      threadId: response.threadId,
    };
  };

  return (
    <section className="automations-screen" aria-label="Automations">
      <nav className="settings-nav" aria-label="Automation navigation">
        <header className="settings-nav__masthead">
          <p className="settings-nav__brand">
            Pwr<span className="settings-nav__brand-accent">Agent</span>
          </p>
        </header>
        <button className="settings-nav__exit" type="button" onClick={props.onClose}>
          <span aria-hidden="true">&lt;</span> Exit Automations
        </button>
        <button
          className="settings-nav__new"
          type="button"
          onClick={() => setEditorMode({ kind: "create" })}
        >
          <span aria-hidden="true" className="settings-nav__new-plus">+</span>{" "}
          New Automation
        </button>
        <p className="settings-nav__group-label">Schedules</p>
        <button
          aria-current="page"
          className="settings-nav__button is-active"
          type="button"
        >
          All Automations
        </button>
      </nav>

      <div className="automations-main">
        <header className="settings-titlebar">
          <div className="settings-titlebar__breadcrumb">
            <span className="settings-titlebar__eyebrow">Automations</span>
            <span aria-hidden="true" className="settings-titlebar__separator">
              &gt;
            </span>
            <span className="settings-titlebar__current">All Automations</span>
          </div>
          <div className="settings-titlebar__spacer" />
          <MessagingStatusBar
            desktopApi={props.desktopApi}
            onOpenActivity={props.onOpenMessagingActivity}
            onOpenSettings={props.onOpenMessagingSettings}
          />
        </header>

        <div className="automations-content">
          <div className="automations-toolbar">
            <div>
              <p className="eyebrow">Serial Agent queues</p>
              <h2>Automations</h2>
            </div>
          </div>

          {editorMode ? (
            <div className="automations-editor-panel">
              <AutomationEditor
                desktopApi={props.desktopApi}
                directories={props.directories}
                mode={
                  editorMode.kind === "create"
                    ? { kind: "create" }
                    : { automation: editorMode.automation, kind: "edit" }
                }
                saving={saving}
                threads={props.threads}
                onCancel={() => setEditorMode(undefined)}
                onPromoteThread={promoteThreadToAgent}
                onSubmit={submitEditor}
              />
            </div>
          ) : null}

          {automations.error ? (
            <p className="automations-error" role="alert">
              {automations.error}
            </p>
          ) : null}

          {automations.loading ? (
            <p className="settings-empty">Loading automations...</p>
          ) : automations.automations.length === 0 ? (
            <p className="settings-empty">No automations configured.</p>
          ) : (
            <div className="automations-table" role="table" aria-label="Automations">
              <div className="automations-table__header" role="row">
                <span role="columnheader">Automation</span>
                <span role="columnheader">Runs as</span>
                <span role="columnheader">Trigger</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Actions</span>
              </div>
              {automations.automations.map((automation, index) => {
                const thread = threadsByKey.get(
                  buildThreadIdentityKey(automation.backend, automation.threadId),
                );
                return (
                  <AutomationTableRow
                    key={automation.id}
                    automation={automation}
                    desktopApi={props.desktopApi}
                    expanded={expandedAutomationId === automation.id}
                    hasRowsBelow={index < automations.automations.length - 1}
                    thread={thread}
                    onDelete={async () => {
                      await automations.deleteAutomation({
                        automationId: automation.id,
                      });
                      await props.onRefreshNavigation?.();
                    }}
                    onEdit={() => setEditorMode({ automation, kind: "edit" })}
                    onExpand={() =>
                      setExpandedAutomationId((current) =>
                        current === automation.id ? undefined : automation.id,
                      )
                    }
                    onPauseResume={async () => {
                      if (automation.status === "paused") {
                        await automations.resumeAutomation({
                          automationId: automation.id,
                        });
                      } else {
                        await automations.pauseAutomation({
                          automationId: automation.id,
                        });
                      }
                      await props.onRefreshNavigation?.();
                    }}
                    onRunNow={async () => {
                      await automations.runAutomationNow({
                        automationId: automation.id,
                      });
                      setExpandedAutomationId(automation.id);
                      await props.onRefreshNavigation?.();
                    }}
                    onReplayed={async () => {
                      await automations.refresh();
                      setExpandedAutomationId(automation.id);
                      await props.onRefreshNavigation?.();
                    }}
                    onSelectThread={
                      thread && props.onSelectThread
                        ? () => props.onSelectThread?.(thread)
                        : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AutomationTableRow(props: {
  automation: AutomationDetail;
  desktopApi?: DesktopApi;
  expanded: boolean;
  /** Whether another automation follows this one in the list. */
  hasRowsBelow: boolean;
  onDelete: () => Promise<void>;
  onEdit: () => void;
  onExpand: () => void;
  onPauseResume: () => Promise<void>;
  onReplayed?: () => Promise<void>;
  onRunNow: () => Promise<void>;
  onSelectThread?: () => void;
  thread?: NavigationThreadSummary;
}) {
  const [busy, setBusy] = useState<string>();
  // The run lines stick below this row, and its height depends on how much of
  // the execution profile the automation overrides — so it is measured rather
  // than assumed. Only while expanded: a collapsed row has nothing under it.
  const rowRef = useRef<HTMLElement>(null);
  const [rowHeight, setRowHeight] = useState(0);
  useEffect(() => {
    const element = rowRef.current;
    if (!props.expanded || !element || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      setRowHeight(element.offsetHeight);
    });
    observer.observe(element);
    setRowHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, [props.expanded]);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayCandidates, setReplayCandidates] =
    useState<ListAutomationReplayCandidatesResponse>();
  const [replayError, setReplayError] = useState<string>();
  const inboundTriggered = props.automation.triggers.some(
    (trigger) => trigger.kind === "inbound_message",
  );

  const toggleReplay = async (): Promise<void> => {
    if (replayOpen) {
      setReplayOpen(false);
      return;
    }
    setReplayOpen(true);
    setReplayError(undefined);
    setReplayCandidates(undefined);
    try {
      const response = await props.desktopApi?.listAutomationReplayCandidates?.({
        automationId: props.automation.id,
      });
      setReplayCandidates(
        response ?? { candidates: [], supported: false },
      );
    } catch (caught) {
      setReplayError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const replayMessage = async (
    candidate: AutomationReplayCandidate,
  ): Promise<void> => {
    await props.desktopApi?.replayAutomationInbound?.({
      automationId: props.automation.id,
      message: candidate.message,
    });
    setReplayOpen(false);
    await props.onReplayed?.();
  };
  const runAction = async (
    action: string,
    callback: () => Promise<void>,
  ): Promise<void> => {
    setBusy(action);
    try {
      await callback();
    } finally {
      setBusy(undefined);
    }
  };

  const agentLabel = formatAutomationAgentLabel(props);
  const threadSubtitle = props.thread?.agent
    ? props.thread.title === agentLabel
      ? undefined
      : props.thread.title
    : "legacy thread";
  const scheduleTriggered = props.automation.triggers.some(
    (trigger) => trigger.kind === "schedule",
  );

  return (
    <div
      className="automations-table__group"
      role="rowgroup"
      style={
        rowHeight > 0
          ? ({ "--automation-row-h": `${rowHeight}px` } as CSSProperties)
          : undefined
      }
    >
      <article className="automations-table__row" ref={rowRef} role="row">
        <div className="automations-table__identity" role="cell">
          <button
            aria-expanded={props.expanded}
            aria-label={`${props.expanded ? "Hide" : "Show"} run history for ${props.automation.name}`}
            className="automations-table__disclosure"
            type="button"
            onClick={props.onExpand}
          >
            <ChevronRightIcon aria-hidden="true" size={14} />
          </button>
          <div className="automations-table__identity-text">
            <h3>{props.automation.name}</h3>
            {props.onSelectThread ? (
              <button
                className="automations-table__thread-link"
                type="button"
                onClick={props.onSelectThread}
              >
                {agentLabel}
              </button>
            ) : (
              <span>{agentLabel}</span>
            )}
            {threadSubtitle ? <p>{threadSubtitle}</p> : null}
          </div>
        </div>
        <AutomationRuntimeCell automation={props.automation} />
        <div role="cell">
          <span>{props.automation.scheduleSummary}</span>
          {props.automation.nextRunAt ? (
            <p>Next {formatAutomationRelative(props.automation.nextRunAt)}</p>
          ) : null}
          {/* Backlog policy only decides what happens to *missed scheduled*
              runs, so it belongs with the schedule rather than under the
              automation's name where it outranked everything else. */}
          {scheduleTriggered ? (
            <p>{formatBacklogPolicy(props.automation.backlogPolicy)}</p>
          ) : null}
        </div>
        <div role="cell">
          <span className={`automation-status automation-status--${props.automation.status}`}>
            {formatAutomationStatus(props.automation.status)}
          </span>
          <p>{formatAutomationLatestRun(props.automation)}</p>
          {formatCostTodayMicros(props.automation.costTodayMicros) ? (
            <p>{formatCostTodayMicros(props.automation.costTodayMicros)}</p>
          ) : null}
        </div>
        <div className="automations-table__actions" role="cell">
          {inboundTriggered ? (
            <button
              className="context-list__action"
              disabled={Boolean(busy)}
              type="button"
              onClick={() => void toggleReplay()}
            >
              Replay
            </button>
          ) : (
            <button
              className="context-list__action"
              disabled={Boolean(busy)}
              type="button"
              onClick={() => void runAction("run", props.onRunNow)}
            >
              Run
            </button>
          )}
          <button className="context-list__action" type="button" onClick={props.onEdit}>
            Edit
          </button>
          {/* Pause and Delete are rarer and one of them is destructive, so
              they sit behind an overflow rather than competing with Run and
              Edit for the same visual weight in every row. */}
          <AutomationRowMenu
            busy={Boolean(busy)}
            name={props.automation.name}
            paused={props.automation.status === "paused"}
            onDelete={() => void runAction("delete", props.onDelete)}
            onPauseResume={() => void runAction("pause", props.onPauseResume)}
          />
        </div>
      </article>
      {replayOpen ? (
        <div className="automations-table__replay">
          <p className="automations-table__replay-lead">
            Replay a recent message from the trigger conversation. The badge is
            the filter&rsquo;s live verdict — replaying a non-matching message
            is a way to test what the automation would do if the filter let it
            through.
          </p>
          {replayError ? (
            <p className="automations-error" role="alert">
              {replayError}
            </p>
          ) : replayCandidates === undefined ? (
            <p className="automation-field__hint">Loading recent messages…</p>
          ) : !replayCandidates.supported ? (
            <p className="automation-field__hint">
              This provider can&rsquo;t serve conversation history, so there is
              nothing to replay. Use &ldquo;Preview live messages&rdquo; in the
              editor to test against new traffic instead.
            </p>
          ) : replayCandidates.candidates.length === 0 ? (
            <p className="automation-field__hint">
              No recent messages in the trigger conversation.
            </p>
          ) : (
            <ul className="automation-preview__list">
              {replayCandidates.candidates.map((candidate) => (
                <li
                  className={`automation-preview__item${candidate.matches ? " is-match" : ""}`}
                  key={candidate.message.id}
                >
                  <span className="automation-preview__meta">
                    {new Date(candidate.message.receivedAt).toLocaleTimeString()}{" "}
                    · {candidate.message.actor.displayName
                      ?? candidate.message.actor.platformUserId}
                  </span>
                  <span className="automation-preview__row-text">
                    {candidate.message.text || "(no text)"}
                  </span>
                  <span className="automation-preview__row-actions">
                    {candidate.matches ? (
                      <span className="automation-preview__badge">matches</span>
                    ) : (
                      <span className="automation-preview__badge automation-preview__badge--muted">
                        no match
                      </span>
                    )}
                    <button
                      className="automation-preview__use-sender"
                      disabled={Boolean(busy)}
                      type="button"
                      onClick={() =>
                        void runAction("replay", () => replayMessage(candidate))
                      }
                    >
                      {candidate.matches ? "Replay" : "Replay anyway"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {props.expanded ? (
        <AutomationTableHistory
          automationId={props.automation.id}
          capHeight={props.hasRowsBelow}
          desktopApi={props.desktopApi}
        />
      ) : null}
    </div>
  );
}

/**
 * "What will this thing run as" — the answer an operator needs before they
 * decide whether an automation deserves watching. Backend pill and model line
 * reuse the sub-agent card's vocabulary; access mode and working directory are
 * here because a Full Access automation loose in a real repo is the case worth
 * spotting from across the table.
 */
function AutomationRuntimeCell(props: { automation: AutomationDetail }) {
  const profile = props.automation.executionProfile;
  const runtimeDetails = [
    profile?.model,
    profile?.reasoningEffort,
    profile?.fastMode ? "Fast" : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const fullAccess = profile?.executionMode === "full-access";
  return (
    <div className="automations-table__runtime" role="cell">
      <p className="automations-table__runtime-line">
        <span className="automation-runtime__provider">
          {formatBackendLabel(profile?.backend ?? props.automation.backend)}
        </span>
        <span className="automation-runtime__model">
          {runtimeDetails || "Agent default"}
        </span>
      </p>
      {/* Only stated when the automation actually overrides it. Printing
          "Default Access" for an inheriting automation would claim a setting
          it does not hold. */}
      {profile?.executionMode ? (
        <p className="automations-table__runtime-line">
          <span
            className={`automation-runtime__access${
              fullAccess ? " automation-runtime__access--elevated" : ""
            }`}
          >
            {formatExecutionModeLabel(profile.executionMode)}
          </span>
        </p>
      ) : null}
      {profile?.cwd ? (
        <p className="automations-table__cwd" title={profile.cwd}>
          {formatWorkspacePathLabel(profile.cwd)}
        </p>
      ) : null}
    </div>
  );
}

function AutomationRowMenu(props: {
  busy: boolean;
  name: string;
  paused: boolean;
  onDelete: () => void;
  onPauseResume: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const ref = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div className="automations-table__menu" ref={ref}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`More actions for ${props.name}`}
        className="context-list__action automations-table__menu-button"
        disabled={props.busy}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreVerticalIcon aria-hidden="true" size={14} />
      </button>
      {open ? (
        <div className="automations-table__menu-list" id={menuId} role="menu">
          <button
            className="automations-table__menu-item"
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              props.onPauseResume();
            }}
          >
            {props.paused ? "Resume" : "Pause"}
          </button>
          <button
            className="automations-table__menu-item automations-table__menu-item--danger"
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              props.onDelete();
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatAutomationAgentLabel(props: {
  automation: AutomationDetail;
  thread?: NavigationThreadSummary;
}): string {
  return (
    props.thread?.agent?.name ??
    props.thread?.title ??
    `Assigned thread ...${formatThreadIdSuffix(props.automation.threadId)}`
  );
}

function formatThreadIdSuffix(threadId: string): string {
  return threadId.length > 12 ? threadId.slice(-12) : threadId;
}

function formatAutomationLatestRun(automation: AutomationDetail): string {
  if (!automation.lastRunStatus) {
    return "No runs yet";
  }
  const relative = formatAutomationRelative(automation.lastRunAt);
  if (automation.lastRunStatus === "running") {
    return `Running since ${relative}`;
  }
  if (automation.lastRunStatus === "queued") {
    return `Queued ${relative}`;
  }
  if (automation.lastRunStatus === "pending") {
    return `Pending ${relative}`;
  }
  return `Last ${automation.lastRunStatus} ${relative}`;
}

function AutomationTableHistory(props: {
  automationId: string;
  /**
   * Scroll the run list inside its own box instead of letting it grow. The
   * cap exists to keep the *next* automation reachable, so it is applied only
   * when there is a next automation — otherwise it reserves screen space for
   * nobody and squeezes an open run's details into a sliver.
   */
  capHeight: boolean;
  desktopApi?: DesktopApi;
}) {
  const runs = useAutomationRuns(props.desktopApi, props.automationId);
  const [expandedRunId, setExpandedRunId] = useState<string>();

  return (
    <div
      className={`automations-table__history${
        props.capHeight ? " automations-table__history--capped" : ""
      }`}
    >
      {runs.loading ? (
        <p>Loading run history...</p>
      ) : runs.error ? (
        <p>{runs.error}</p>
      ) : runs.runs.length === 0 ? (
        <p>No runs yet.</p>
      ) : (
        <ol className="automation-run-history">
          {runs.runs.map((run) => (
            <AutomationRunHistoryItem
              key={run.id}
              desktopApi={props.desktopApi}
              expanded={expandedRunId === run.id}
              run={run}
              onToggle={() =>
                setExpandedRunId((current) =>
                  current === run.id ? undefined : run.id,
                )
              }
            />
          ))}
        </ol>
      )}
    </div>
  );
}
