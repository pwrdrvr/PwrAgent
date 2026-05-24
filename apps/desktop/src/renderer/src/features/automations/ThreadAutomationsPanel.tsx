import { useMemo, useState } from "react";
import type {
  AppServerThreadEntry,
  AutomationDetail,
  AutomationRunTranscriptEvent,
  AutomationRunRollout,
  AutomationRunStatus,
  AutomationRunWindow,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  formatAutomationRelative,
  formatAutomationStatus,
  formatAutomationTimestamp,
  formatBacklogPolicy,
  formatRunStatus,
} from "./automation-format";
import {
  AutomationEditor,
  type AutomationEditorSubmit,
} from "./AutomationEditor";
import {
  sameAutomationThread,
  useAutomationRunArtifact,
  useAutomationRuns,
  useAutomations,
} from "./useAutomations";

type ThreadAutomationsPanelProps = {
  desktopApi?: DesktopApi;
  thread: NavigationThreadSummary;
  onRefreshNavigation?: () => Promise<void>;
};

export function ThreadAutomationsPanel(props: ThreadAutomationsPanelProps) {
  const isAgentThread = Boolean(props.thread.agent);
  const automations = useAutomations(props.desktopApi, {
    backend: props.thread.source,
    threadId: props.thread.id,
  });
  const [editorMode, setEditorMode] = useState<
    | { kind: "create" }
    | { automation: AutomationDetail; kind: "edit" }
    | undefined
  >();
  const [saving, setSaving] = useState(false);
  const [expandedAutomationId, setExpandedAutomationId] = useState<string>();
  const expandedAutomation = useMemo(
    () =>
      automations.automations.find(
        (automation) => automation.id === expandedAutomationId,
      ),
    [automations.automations, expandedAutomationId],
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
    <section className="context-panel__section thread-automations">
      <div className="automation-section-header">
        <div>
          <h3>Automations</h3>
          <p className="automation-section-header__meta">
            {formatThreadAutomationSummary(props.thread)}
          </p>
        </div>
        <button
          className="context-list__action"
          disabled={!isAgentThread}
          title={
            isAgentThread
              ? "Add automation"
              : "Mark this thread as an Agent first"
          }
          type="button"
          onClick={() => setEditorMode({ kind: "create" })}
        >
          Add
        </button>
      </div>

      {editorMode ? (
        <AutomationEditor
          mode={
            editorMode.kind === "create"
              ? {
                  assignment: {
                    backend: props.thread.source,
                    threadId: props.thread.id,
                  },
                  kind: "create",
                }
              : { automation: editorMode.automation, kind: "edit" }
          }
          saving={saving}
          onCancel={() => setEditorMode(undefined)}
          onSubmit={submitEditor}
        />
      ) : null}

      {automations.error ? (
        <p className="context-empty context-empty--error">{automations.error}</p>
      ) : null}

      {!isAgentThread ? (
        <p className="context-empty">Automations attach to Agent threads.</p>
      ) : null}

      {automations.loading ? (
        <p className="context-empty">Loading automations...</p>
      ) : automations.automations.length === 0 && !editorMode ? (
        isAgentThread ? (
          <p className="context-empty">No automations on this Agent.</p>
        ) : null
      ) : (
        <ul className="automation-list">
          {automations.automations.map((automation) => (
            <li key={automation.id} className="automation-list__item">
              <AutomationSummary
                automation={automation}
                expanded={automation.id === expandedAutomationId}
                onDelete={async () => {
                  await automations.deleteAutomation({ automationId: automation.id });
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
                    await automations.resumeAutomation({ automationId: automation.id });
                  } else {
                    await automations.pauseAutomation({ automationId: automation.id });
                  }
                  await props.onRefreshNavigation?.();
                }}
                onRunNow={async () => {
                  await automations.runAutomationNow({ automationId: automation.id });
                  setExpandedAutomationId(automation.id);
                  await props.onRefreshNavigation?.();
                }}
              />
              {expandedAutomation?.id === automation.id ? (
                <AutomationRunHistory
                  automationId={automation.id}
                  desktopApi={props.desktopApi}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AutomationSummary(props: {
  automation: AutomationDetail;
  expanded: boolean;
  onDelete: () => Promise<void>;
  onEdit: () => void;
  onExpand: () => void;
  onPauseResume: () => Promise<void>;
  onRunNow: () => Promise<void>;
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
    <article className="automation-row">
      <div className="automation-row__main">
        <div className="automation-row__title-line">
          <h4>{props.automation.name}</h4>
          <span className={`automation-status automation-status--${props.automation.status}`}>
            {formatAutomationStatus(props.automation.status)}
          </span>
        </div>
        <p className="automation-row__schedule">{props.automation.scheduleSummary}</p>
        <p className="automation-row__meta">
          next {formatAutomationRelative(props.automation.nextRunAt)} -{" "}
          {formatBacklogPolicy(props.automation.backlogPolicy)}
        </p>
        {props.automation.pendingRunCount || props.automation.coalescedWindowCount ? (
          <p className="automation-row__meta">
            {props.automation.pendingRunCount ?? 0} queued -{" "}
            {props.automation.coalescedWindowCount ?? 0} coalesced
          </p>
        ) : null}
      </div>
      <div className="automation-row__actions">
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
  );
}

export function AutomationRunHistory(props: {
  automationId: string;
  desktopApi?: DesktopApi;
}) {
  const runs = useAutomationRuns(props.desktopApi, props.automationId);
  const [expandedRunId, setExpandedRunId] = useState<string>();

  if (runs.loading) {
    return <p className="automation-run-history__empty">Loading run history...</p>;
  }

  if (runs.error) {
    return <p className="automation-run-history__empty">{runs.error}</p>;
  }

  if (runs.runs.length === 0) {
    return <p className="automation-run-history__empty">No runs yet.</p>;
  }

  return (
    <ol className="automation-run-history">
      {runs.runs.map((run) => (
        <AutomationRunHistoryItem
          key={run.id}
          desktopApi={props.desktopApi}
          expanded={expandedRunId === run.id}
          run={run}
          onToggle={() =>
            setExpandedRunId((current) => (current === run.id ? undefined : run.id))
          }
        />
      ))}
    </ol>
  );
}

export function AutomationRunHistoryItem(props: {
  desktopApi?: DesktopApi;
  expanded: boolean;
  run: ReturnType<typeof useAutomationRuns>["runs"][number];
  onToggle: () => void;
}) {
  const artifact = useAutomationRunArtifact(
    props.desktopApi,
    props.expanded ? props.run.id : undefined,
  );
  return (
    <li className="automation-run-history__item">
      <span className={`automation-run-status automation-run-status--${props.run.status}`}>
        {formatRunStatus(props.run.status)}
      </span>
      <span>
        {props.run.trigger}
        {props.run.scheduledFor
          ? ` for ${formatAutomationTimestamp(props.run.scheduledFor)}`
          : ""}
      </span>
      <span className="automation-run-history__time">
        {formatAutomationTimestamp(
          props.run.completedAt ?? props.run.startedAt ?? props.run.queuedAt,
        )}
      </span>
      {props.run.scheduledWindows.length > 1 ? (
        <span className="automation-run-history__time">
          {props.run.scheduledWindows.length} windows
        </span>
      ) : null}
      {props.run.errorMessage ? (
        <span className="automation-run-history__error">{props.run.errorMessage}</span>
      ) : null}
      <button className="context-list__action" type="button" onClick={props.onToggle}>
        {props.expanded ? "Hide details" : "Details"}
      </button>
      {props.expanded ? (
        <AutomationRunArtifactDetails
          backendThreadId={props.run.backendThreadId}
          backendTurnId={props.run.backendTurnId}
          error={artifact.error}
          finalText={artifact.artifact?.finalText}
          loading={artifact.loading}
          outputDecision={artifact.artifact?.outputDecision?.kind}
          rollout={artifact.rollout}
          scheduledWindows={props.run.scheduledWindows}
          status={props.run.status}
          transcriptEvents={artifact.artifact?.transcriptEvents ?? []}
        />
      ) : null}
    </li>
  );
}

function AutomationRunArtifactDetails(props: {
  backendThreadId?: string;
  backendTurnId?: string;
  error?: string;
  finalText?: string;
  loading: boolean;
  outputDecision?: string;
  rollout?: AutomationRunRollout;
  scheduledWindows: AutomationRunWindow[];
  status: AutomationRunStatus;
  transcriptEvents: AutomationRunTranscriptEvent[];
}) {
  if (props.loading) {
    return <p className="automation-run-history__time">Loading details...</p>;
  }
  if (props.error) {
    return <p className="automation-run-history__error">{props.error}</p>;
  }
  const hasRollout =
    Boolean(props.rollout?.replay?.entries.length) ||
    Boolean(props.rollout?.errorMessage) ||
    Boolean(props.backendThreadId);
  const hasScheduledWindows = props.scheduledWindows.length > 0;
  const hasTranscriptEvents = props.transcriptEvents.length > 0;
  if (
    !props.finalText &&
    !props.outputDecision &&
    !hasRollout &&
    !hasScheduledWindows &&
    !hasTranscriptEvents
  ) {
    return (
      <p className="automation-run-history__time">
        {props.status === "queued" || props.status === "pending"
          ? "Run is waiting in the automation queue. No rollout thread has started yet."
          : "No artifact details stored."}
      </p>
    );
  }
  return (
    <div className="automation-run-history__artifact">
      {props.outputDecision ? (
        <p className="automation-run-history__time">
          Output decision: {props.outputDecision}
        </p>
      ) : null}
      {props.finalText ? <pre>{props.finalText}</pre> : null}
      {hasTranscriptEvents ? (
        <AutomationRunTranscriptEvents events={props.transcriptEvents} />
      ) : null}
      {hasScheduledWindows ? (
        <div className="automation-run-history__section">
          <p className="automation-run-history__section-title">
            Scheduled windows covered
          </p>
          <ul className="automation-run-history__windows">
            {props.scheduledWindows.map((window) => (
              <li key={window.scheduledFor}>
                {formatAutomationTimestamp(window.scheduledFor)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {hasRollout ? (
        <AutomationRunRolloutDetails
          backendThreadId={props.backendThreadId}
          backendTurnId={props.backendTurnId}
          rollout={props.rollout}
        />
      ) : null}
    </div>
  );
}

function AutomationRunTranscriptEvents(props: {
  events: AutomationRunTranscriptEvent[];
}) {
  return (
    <div className="automation-run-history__section">
      <p className="automation-run-history__section-title">Captured automation events</p>
      <ol className="automation-run-history__rollout">
        {props.events.map((event) => (
          <li className="automation-run-history__rollout-entry" key={event.id}>
            <p className="automation-run-history__rollout-heading">
              {formatAutomationTranscriptEventKind(event.kind)}
              {" - "}
              {formatAutomationTimestamp(event.at)}
            </p>
            {event.text ? <pre>{event.text}</pre> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function AutomationRunRolloutDetails(props: {
  backendThreadId?: string;
  backendTurnId?: string;
  rollout?: AutomationRunRollout;
}) {
  const threadId = props.rollout?.threadId ?? props.backendThreadId;
  const turnId = props.rollout?.turnId ?? props.backendTurnId;
  const entries = props.rollout?.replay?.entries ?? [];
  return (
    <div className="automation-run-history__section">
      <p className="automation-run-history__section-title">Ephemeral rollout</p>
      {threadId ? (
        <p className="automation-run-history__time">
          Thread {threadId}
          {turnId ? ` - turn ${turnId}` : ""}
        </p>
      ) : null}
      {props.rollout?.errorMessage ? (
        <p className="automation-run-history__error">{props.rollout.errorMessage}</p>
      ) : null}
      {entries.length > 0 ? (
        <ol className="automation-run-history__rollout">
          {entries.map((entry) => (
            <AutomationRunRolloutEntry entry={entry} key={entry.id} />
          ))}
        </ol>
      ) : props.rollout?.errorMessage ? null : (
        <p className="automation-run-history__time">
          No rollout entries were returned for this run.
        </p>
      )}
    </div>
  );
}

function AutomationRunRolloutEntry(props: { entry: AppServerThreadEntry }) {
  const entry = props.entry;
  if (entry.type === "message") {
    return (
      <li className="automation-run-history__rollout-entry">
        <p className="automation-run-history__rollout-heading">
          {entry.role}
          {entry.phase ? ` - ${entry.phase}` : ""}
        </p>
        {entry.text ? <pre>{entry.text}</pre> : null}
      </li>
    );
  }

  if (entry.type === "activity") {
    return (
      <li className="automation-run-history__rollout-entry">
        <p className="automation-run-history__rollout-heading">
          {entry.summary}
          {entry.status ? ` - ${entry.status}` : ""}
        </p>
        {entry.details.length > 0 ? (
          <ul className="automation-run-history__rollout-details">
            {entry.details.map((detail) => (
              <li key={detail.id}>
                <span>{detail.label}</span>
                {detail.command?.displayCommand ? (
                  <pre>{detail.command.displayCommand}</pre>
                ) : null}
                {detail.command?.output ? <pre>{detail.command.output}</pre> : null}
                {detail.fileDiff?.diff ? <pre>{detail.fileDiff.diff}</pre> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  if (entry.type === "plan") {
    return (
      <li className="automation-run-history__rollout-entry">
        <p className="automation-run-history__rollout-heading">plan</p>
        {entry.explanation ? <pre>{entry.explanation}</pre> : null}
        {entry.markdown ? <pre>{entry.markdown}</pre> : null}
        {entry.steps.length > 0 ? (
          <ol className="automation-run-history__rollout-details">
            {entry.steps.map((step) => (
              <li key={`${step.status}:${step.step}`}>
                {step.status}: {step.step}
              </li>
            ))}
          </ol>
        ) : null}
      </li>
    );
  }

  return (
    <li className="automation-run-history__rollout-entry">
      <p className="automation-run-history__rollout-heading">
        review{entry.status ? ` - ${entry.status}` : ""}
      </p>
      <pre>{entry.displayText ?? entry.review}</pre>
    </li>
  );
}

function formatAutomationTranscriptEventKind(
  kind: AutomationRunTranscriptEvent["kind"],
): string {
  switch (kind) {
    case "assistant_final":
      return "assistant";
    case "invocation":
      return "started";
    default:
      return kind;
  }
}

function formatThreadAutomationSummary(thread: NavigationThreadSummary): string {
  const summary = thread.automationSummary;
  if (!summary || summary.totalCount === 0) {
    return thread.agent ? "One serial queue per Agent." : "No Agent automation queue.";
  }
  const queued = summary.pendingRunCount
    ? ` - ${summary.pendingRunCount} queued`
    : "";
  const coalesced = summary.coalescedWindowCount
    ? ` - ${summary.coalescedWindowCount} coalesced`
    : "";
  return `${summary.enabledCount} enabled, ${summary.pausedCount} paused${queued}${coalesced}`;
}

export function automationsForThread(
  automations: AutomationDetail[],
  thread: NavigationThreadSummary,
): AutomationDetail[] {
  return automations.filter((automation) =>
    sameAutomationThread(automation, thread.source, thread.id),
  );
}
