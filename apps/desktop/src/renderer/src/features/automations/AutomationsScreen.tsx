import { useMemo, useState } from "react";
import type {
  AutomationDetail,
  MessagingChannelKind,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import {
  formatAutomationRelative,
  formatAutomationStatus,
  formatBacklogPolicy,
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
  onRefreshNavigation?: () => Promise<void>;
  onSelectThread?: (thread: NavigationThreadSummary) => void;
  threads: NavigationThreadSummary[];
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
          `${thread.source}:${thread.id}`,
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
          />
        </header>

        <div className="automations-content">
          <div className="automations-toolbar">
            <div>
              <p className="eyebrow">Serial Agent queues</p>
              <h2>Automations</h2>
            </div>
            <button
              className="button button--primary"
              type="button"
              onClick={() => setEditorMode({ kind: "create" })}
            >
              New Automation
            </button>
          </div>

          {editorMode ? (
            <div className="automations-editor-panel">
              <AutomationEditor
                mode={
                  editorMode.kind === "create"
                    ? { kind: "create" }
                    : { automation: editorMode.automation, kind: "edit" }
                }
                saving={saving}
                threads={props.threads}
                onCancel={() => setEditorMode(undefined)}
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
                <span role="columnheader">Agent</span>
                <span role="columnheader">Schedule</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Actions</span>
              </div>
              {automations.automations.map((automation) => {
                const thread = threadsByKey.get(
                  `${automation.backend}:${automation.threadId}`,
                );
                return (
                  <AutomationTableRow
                    key={automation.id}
                    automation={automation}
                    desktopApi={props.desktopApi}
                    expanded={expandedAutomationId === automation.id}
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
  onDelete: () => Promise<void>;
  onEdit: () => void;
  onExpand: () => void;
  onPauseResume: () => Promise<void>;
  onRunNow: () => Promise<void>;
  onSelectThread?: () => void;
  thread?: NavigationThreadSummary;
}) {
  const [busy, setBusy] = useState<string>();
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

  return (
    <>
      <article className="automations-table__row" role="row">
        <div role="cell">
          <h3>{props.automation.name}</h3>
          <p>{formatBacklogPolicy(props.automation.backlogPolicy)}</p>
        </div>
        <div role="cell">
          {props.onSelectThread ? (
            <button
              className="automations-table__thread-link"
              type="button"
              onClick={props.onSelectThread}
            >
              {formatAutomationAgentLabel(props)}
            </button>
          ) : (
            <span>{formatAutomationAgentLabel(props)}</span>
          )}
          <p>{props.thread?.agent ? props.thread.title : "legacy thread"}</p>
        </div>
        <div role="cell">
          <span>{props.automation.scheduleSummary}</span>
          <p>Next {formatAutomationRelative(props.automation.nextRunAt)}</p>
        </div>
        <div role="cell">
          <span className={`automation-status automation-status--${props.automation.status}`}>
            {formatAutomationStatus(props.automation.status)}
          </span>
          <p>{formatAutomationLatestRun(props.automation)}</p>
        </div>
        <div className="automations-table__actions" role="cell">
          <button
            className="context-list__action"
            disabled={Boolean(busy)}
            type="button"
            onClick={() => void runAction("run", props.onRunNow)}
          >
            Run
          </button>
          <button className="context-list__action" type="button" onClick={props.onEdit}>
            Edit
          </button>
          <button
            className="context-list__action"
            disabled={Boolean(busy)}
            type="button"
            onClick={() => void runAction("pause", props.onPauseResume)}
          >
            {props.automation.status === "paused" ? "Resume" : "Pause"}
          </button>
          <button className="context-list__action" type="button" onClick={props.onExpand}>
            {props.expanded ? "Hide" : "History"}
          </button>
          <button
            className="context-list__action context-list__action--danger"
            disabled={Boolean(busy)}
            type="button"
            onClick={() => void runAction("delete", props.onDelete)}
          >
            Delete
          </button>
        </div>
      </article>
      {props.expanded ? (
        <AutomationTableHistory
          automationId={props.automation.id}
          desktopApi={props.desktopApi}
        />
      ) : null}
    </>
  );
}

function formatAutomationAgentLabel(props: {
  automation: AutomationDetail;
  thread?: NavigationThreadSummary;
}): string {
  return props.thread?.agent?.name ?? props.thread?.title ?? props.automation.threadId;
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
  desktopApi?: DesktopApi;
}) {
  const runs = useAutomationRuns(props.desktopApi, props.automationId);
  const [expandedRunId, setExpandedRunId] = useState<string>();

  return (
    <div className="automations-table__history">
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
