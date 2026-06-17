import { useId, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  AutomationBacklogPolicy,
  AutomationDetail,
  AutomationScheduleDefinition,
  AutomationWeekday,
  CreateAutomationRequest,
  NavigationThreadSummary,
  ThreadIdentifier,
  UpdateAutomationRequest,
} from "@pwragent/shared";
import {
  AUTOMATION_WEEKDAYS,
  buildThreadIdentityKey,
  formatAutomationScheduleSummary,
  parseThreadIdentityKey,
  validateAutomationScheduleDefinition,
} from "@pwragent/shared";
import { HelpCircleIcon } from "../../icons";

type AutomationEditorMode =
  | {
      automation: AutomationDetail;
      kind: "edit";
    }
  | {
      assignment?: {
        backend: AppServerBackendKind;
        threadId: ThreadIdentifier;
      };
      kind: "create";
    };

export type AutomationEditorSubmit =
  | { kind: "create"; request: CreateAutomationRequest }
  | { kind: "update"; request: UpdateAutomationRequest };

type AutomationEditorProps = {
  mode: AutomationEditorMode;
  onCancel: () => void;
  onPromoteThread?: (
    thread: NavigationThreadSummary,
  ) => Promise<{
    agent?: NavigationThreadSummary["agent"];
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  }>;
  onSubmit: (submission: AutomationEditorSubmit) => Promise<void>;
  saving?: boolean;
  threads?: NavigationThreadSummary[];
};

type ScheduleFormKind = "interval" | "weekdays" | "weekly";
type AgentPickerTab = "agents" | "threads";

type AgentThreadOption = {
  key: string;
  label: string;
  meta: string;
  thread?: NavigationThreadSummary;
  title: string;
};

const DAY_LABELS: Record<AutomationWeekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

const DEFER_AGENT_KEY = "__defer_agent__";
const DEFER_AGENT_LABEL = "I'll set this up later...";

export function AutomationEditor(props: AutomationEditorProps) {
  const initialAutomation =
    props.mode.kind === "edit" ? props.mode.automation : undefined;
  const initialSchedule = initialAutomation?.schedule;
  const initialAssignment = readInitialAssignment(props);
  const initialThreadKey = initialAssignment
    ? buildThreadKey(initialAssignment.backend, initialAssignment.threadId)
    : "";
  const [name, setName] = useState(initialAutomation?.name ?? "");
  const [taskPrompt, setTaskPrompt] = useState(initialAutomation?.taskPrompt ?? "");
  const [gateEnabled, setGateEnabled] = useState(Boolean(initialAutomation?.gate));
  const [gateCommand, setGateCommand] = useState(initialAutomation?.gate?.command ?? "");
  const [gateCwd, setGateCwd] = useState(initialAutomation?.gate?.cwd ?? "");
  const [gateTimeoutMs, setGateTimeoutMs] = useState(
    initialAutomation?.gate?.timeoutMs
      ? String(initialAutomation.gate.timeoutMs)
      : "60000",
  );
  const [enabled, setEnabled] = useState(initialAutomation?.status !== "paused");
  const [backlogPolicy, setBacklogPolicy] = useState<AutomationBacklogPolicy>(
    initialAutomation?.backlogPolicy ?? "coalesce",
  );
  const [threadKey, setThreadKey] = useState(initialThreadKey);
  const [promotedAgentOptions, setPromotedAgentOptions] = useState<AgentThreadOption[]>(
    [],
  );
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agentPickerTab, setAgentPickerTab] = useState<AgentPickerTab>("agents");
  const [agentQuery, setAgentQuery] = useState("");
  const [agentHelpOpen, setAgentHelpOpen] = useState(false);
  const [agentPromotionError, setAgentPromotionError] = useState<string>();
  const [promotingThreadKey, setPromotingThreadKey] = useState<string>();
  const [scheduleKind, setScheduleKind] = useState<ScheduleFormKind>(
    initialSchedule?.kind ?? "interval",
  );
  const [intervalEvery, setIntervalEvery] = useState(
    initialSchedule?.kind === "interval" ? String(initialSchedule.every) : "5",
  );
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours">(
    initialSchedule?.kind === "interval" ? initialSchedule.unit : "minutes",
  );
  const [timeOfDay, setTimeOfDay] = useState(() => {
    if (initialSchedule?.kind === "weekly" || initialSchedule?.kind === "weekdays") {
      return `${String(initialSchedule.timeOfDay.hour).padStart(2, "0")}:${String(
        initialSchedule.timeOfDay.minute,
      ).padStart(2, "0")}`;
    }
    return "09:00";
  });
  const [daysOfWeek, setDaysOfWeek] = useState<AutomationWeekday[]>(
    initialSchedule?.kind === "weekly"
      ? initialSchedule.daysOfWeek
      : ["monday", "tuesday", "wednesday", "thursday", "friday"],
  );
  const [validationError, setValidationError] = useState<string>();
  const agentLabelId = useId();
  const agentHelpId = useId();
  const canDeferAgent = props.mode.kind === "create";

  const agentOptions = useMemo(
    () => {
      const options: AgentThreadOption[] = (props.threads ?? [])
        .filter((thread) => thread.agent)
        .map((thread) => buildAgentOption(thread));
      for (const promoted of promotedAgentOptions) {
        if (!options.some((thread) => thread.key === promoted.key)) {
          options.unshift(promoted);
        }
      }
      if (
        initialThreadKey &&
        !options.some((thread) => thread.key === initialThreadKey)
      ) {
        const currentThread = (props.threads ?? []).find(
          (thread) => buildThreadKey(thread.source, thread.id) === initialThreadKey,
        );
        options.unshift({
          key: initialThreadKey,
          label: `${formatCurrentAssignmentLabel(currentThread)} (current)`,
          meta: currentThread
            ? formatAgentThreadMeta(currentThread)
            : formatCurrentAssignmentMeta(initialAssignment?.threadId),
          ...(currentThread ? { thread: currentThread } : {}),
          title: currentThread?.title ?? "Current assigned Agent",
        });
      }
      return options;
    },
    [
      promotedAgentOptions,
      initialAssignment?.threadId,
      initialThreadKey,
      props.threads,
    ],
  );
  const threadOptions = useMemo(
    () =>
      (props.threads ?? [])
        .filter((thread) => !thread.agent)
        .map((thread) => buildAgentOption(thread)),
    [props.threads],
  );
  const visibleAgentOptions = useMemo(
    () => filterAgentPickerOptions(agentOptions, agentQuery),
    [agentOptions, agentQuery],
  );
  const visibleThreadOptions = useMemo(
    () => filterAgentPickerOptions(threadOptions, agentQuery),
    [agentQuery, threadOptions],
  );
  const selectedAgent = agentOptions.find((thread) => thread.key === threadKey);
  const agentPickerLabel =
    threadKey === DEFER_AGENT_KEY
      ? DEFER_AGENT_LABEL
      : selectedAgent
        ? selectedAgent.label
        : "Choose Agent";
  const selectedSchedule = buildSchedule({
    daysOfWeek,
    intervalEvery,
    intervalUnit,
    scheduleKind,
    timeOfDay,
  });
  const selectedScheduleSummary =
    selectedSchedule.ok && validateAutomationScheduleDefinition(selectedSchedule.schedule).ok
      ? formatAutomationScheduleSummary(selectedSchedule.schedule)
      : "Invalid schedule";

  const promoteThread = async (option: AgentThreadOption): Promise<void> => {
    if (!props.onPromoteThread) {
      setAgentPromotionError("Thread promotion is unavailable from this screen.");
      return;
    }
    setPromotingThreadKey(option.key);
    setAgentPromotionError(undefined);
    try {
      if (!option.thread) {
        throw new Error("Thread details are unavailable for promotion.");
      }
      const assignment = await props.onPromoteThread(option.thread);
      const promoted = buildPromotedAgentOption(option, assignment);
      setPromotedAgentOptions((current) => [
        promoted,
        ...current.filter((entry) => entry.key !== promoted.key),
      ]);
      setThreadKey(promoted.key);
      setAgentPickerTab("agents");
      setAgentPickerOpen(false);
      setValidationError(undefined);
    } catch (error) {
      setAgentPromotionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPromotingThreadKey(undefined);
    }
  };

  const submit = async (): Promise<void> => {
    const trimmedName = name.trim();
    const trimmedPrompt = taskPrompt.trim();
    if (!trimmedName) {
      setValidationError("Name is required.");
      return;
    }
    if (!trimmedPrompt) {
      setValidationError("Task prompt is required.");
      return;
    }
    if (!selectedSchedule.ok) {
      setValidationError(selectedSchedule.error);
      return;
    }
    const gate = buildGate({
      command: gateCommand,
      cwd: gateCwd,
      enabled: gateEnabled,
      timeoutMs: gateTimeoutMs,
    });
    if (!gate.ok) {
      setValidationError(gate.error);
      return;
    }
    const scheduleValidation = validateAutomationScheduleDefinition(
      selectedSchedule.schedule,
    );
    if (!scheduleValidation.ok) {
      setValidationError(scheduleValidation.error);
      return;
    }

    if (props.mode.kind === "edit") {
      const assignment = readAssignmentFromThreadKey(threadKey);
      if (!assignment) {
        setValidationError("Choose an Agent for this automation.");
        return;
      }
      await props.onSubmit({
        kind: "update",
        request: {
          automationId: props.mode.automation.id,
          ...assignment,
          backlogPolicy,
          enabled,
          gate: gate.gate,
          name: trimmedName,
          schedule: selectedSchedule.schedule,
          taskPrompt: trimmedPrompt,
        },
      });
      return;
    }

    const assignment = readAssignmentFromThreadKey(threadKey);
    if (!assignment) {
      setValidationError(
        "Choose an Agent before saving this automation. You can leave this draft open and set it up later.",
      );
      return;
    }

    await props.onSubmit({
      kind: "create",
      request: {
        ...assignment,
        backlogPolicy,
        enabled,
        gate: gate.gate,
        name: trimmedName,
        schedule: selectedSchedule.schedule,
        taskPrompt: trimmedPrompt,
      },
    });
  };

  return (
    <form
      className="automation-editor"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="automation-field">
        <span>Name</span>
        <input
          value={name}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setValidationError(undefined);
          }}
        />
      </label>

      {shouldShowAgentPicker(props) ? (
        <div className="automation-field automation-agent-field">
          <div className="automation-agent-field__label-row">
            <span id={agentLabelId}>Agent</span>
            <button
              aria-controls={agentHelpId}
              aria-expanded={agentHelpOpen}
              aria-label="What is an Agent?"
              className="automation-agent-help"
              type="button"
              onClick={() => setAgentHelpOpen((open) => !open)}
            >
              <HelpCircleIcon size={14} aria-hidden="true" />
            </button>
          </div>
          {agentHelpOpen ? (
            <div className="automation-agent-help-popover" id={agentHelpId} role="note">
              An Agent is a thread that is allowed to receive Automation responses.
              Typically, you attach one to messaging as a bot's personality
              thread, where it has context about what it has been doing lately so
              it can answer questions quickly without too many tool invokes to
              look up data.
            </div>
          ) : null}
          <div className="automation-agent-picker">
            <button
              aria-expanded={agentPickerOpen}
              aria-haspopup="listbox"
              aria-labelledby={agentLabelId}
              className="automation-agent-picker__trigger"
              type="button"
              onClick={() => {
                setAgentPickerOpen((open) => !open);
                setAgentPromotionError(undefined);
              }}
            >
              <span>{agentPickerLabel}</span>
              <span aria-hidden="true" className="automation-agent-picker__chevron">
                v
              </span>
            </button>
            {agentPickerOpen ? (
              <div className="automation-agent-picker__menu">
                <div
                  className="automation-agent-picker__tabs"
                  role="tablist"
                  aria-label="Agent source"
                >
                  {(["agents", "threads"] as const).map((tab) => (
                    <button
                      key={tab}
                      aria-selected={agentPickerTab === tab}
                      className={`automation-agent-picker__tab${
                        agentPickerTab === tab ? " is-active" : ""
                      }`}
                      role="tab"
                      type="button"
                      onClick={() => {
                        setAgentPickerTab(tab);
                        setAgentPromotionError(undefined);
                      }}
                    >
                      {tab === "agents" ? "Agents" : "Threads"}
                    </button>
                  ))}
                </div>
                <input
                  aria-label="Filter Agent picker"
                  className="automation-agent-picker__search"
                  placeholder={
                    agentPickerTab === "agents" ? "Find an Agent" : "Find a thread"
                  }
                  value={agentQuery}
                  onChange={(event) => setAgentQuery(event.currentTarget.value)}
                />
                {agentPickerTab === "agents" ? (
                  <div role="listbox" aria-label="Agent threads">
                    {canDeferAgent ? (
                      <button
                        className="automation-agent-picker__option automation-agent-picker__option--muted"
                        role="option"
                        type="button"
                        aria-selected={threadKey === DEFER_AGENT_KEY}
                        onClick={() => {
                          setThreadKey(DEFER_AGENT_KEY);
                          setAgentPickerOpen(false);
                          setValidationError(undefined);
                        }}
                      >
                        <span className="automation-agent-picker__option-main">
                          <span>{DEFER_AGENT_LABEL}</span>
                          <span className="automation-agent-picker__option-meta">
                            Save the automation after choosing an Agent.
                          </span>
                        </span>
                      </button>
                    ) : null}
                    {visibleAgentOptions.length > 0 ? (
                      visibleAgentOptions.map((thread) => (
                        <button
                          key={thread.key}
                          className="automation-agent-picker__option"
                          role="option"
                          title={thread.title}
                          type="button"
                          aria-selected={thread.key === threadKey}
                          onClick={() => {
                            setThreadKey(thread.key);
                            setAgentPickerOpen(false);
                            setValidationError(undefined);
                          }}
                        >
                          <span className="automation-agent-picker__option-main">
                            <span>{thread.label}</span>
                            <span className="automation-agent-picker__option-meta">
                              {thread.meta}
                            </span>
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="automation-agent-picker__empty">
                        No Agent threads match.
                      </p>
                    )}
                  </div>
                ) : (
                  <div role="listbox" aria-label="Threads to promote">
                    {visibleThreadOptions.length > 0 ? (
                      visibleThreadOptions.map((thread) => (
                        <button
                          key={thread.key}
                          className="automation-agent-picker__option"
                          disabled={Boolean(promotingThreadKey)}
                          role="option"
                          title={thread.title}
                          type="button"
                          aria-selected={false}
                          onClick={() => {
                            void promoteThread(thread);
                          }}
                        >
                          <span className="automation-agent-picker__option-main">
                            <span>{thread.label}</span>
                            <span className="automation-agent-picker__option-meta">
                              {promotingThreadKey === thread.key
                                ? "Promoting..."
                                : `${thread.meta} - promote to Agent`}
                            </span>
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="automation-agent-picker__empty">
                        No regular threads match.
                      </p>
                    )}
                  </div>
                )}
                {agentPromotionError ? (
                  <p className="automation-editor__error" role="alert">
                    {agentPromotionError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <label className="automation-field">
        <span>Task prompt</span>
        <textarea
          rows={5}
          value={taskPrompt}
          onChange={(event) => {
            setTaskPrompt(event.currentTarget.value);
            setValidationError(undefined);
          }}
        />
      </label>

      <fieldset className="automation-fieldset">
        <legend>Schedule</legend>
        <div className="automation-segmented" role="group" aria-label="Schedule kind">
          {(["interval", "weekdays", "weekly"] as const).map((kind) => (
            <button
              key={kind}
              aria-pressed={scheduleKind === kind}
              className={`automation-segmented__button${
                scheduleKind === kind ? " is-active" : ""
              }`}
              type="button"
              onClick={() => setScheduleKind(kind)}
            >
              {kind}
            </button>
          ))}
        </div>

        {scheduleKind === "interval" ? (
          <div className="automation-inline-fields">
            <label className="automation-field">
              <span>Every</span>
              <input
                min={1}
                type="number"
                value={intervalEvery}
                onChange={(event) => {
                  setIntervalEvery(event.currentTarget.value);
                  setValidationError(undefined);
                }}
              />
            </label>
            <label className="automation-field">
              <span>Unit</span>
              <select
                value={intervalUnit}
                onChange={(event) =>
                  setIntervalUnit(event.currentTarget.value as "minutes" | "hours")
                }
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
              </select>
            </label>
          </div>
        ) : (
          <>
            <label className="automation-field">
              <span>Time</span>
              <input
                type="time"
                value={timeOfDay}
                onChange={(event) => {
                  setTimeOfDay(event.currentTarget.value);
                  setValidationError(undefined);
                }}
              />
            </label>
            {scheduleKind === "weekly" ? (
              <div className="automation-weekdays" role="group" aria-label="Days">
                {AUTOMATION_WEEKDAYS.map((day) => (
                  <button
                    key={day}
                    aria-pressed={daysOfWeek.includes(day)}
                    className={`automation-weekday${
                      daysOfWeek.includes(day) ? " is-active" : ""
                    }`}
                    type="button"
                    onClick={() => {
                      setDaysOfWeek((current) =>
                        current.includes(day)
                          ? current.filter((entry) => entry !== day)
                          : [...current, day],
                      );
                      setValidationError(undefined);
                    }}
                  >
                    {DAY_LABELS[day]}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
        <p className="automation-editor__summary">{selectedScheduleSummary}</p>
      </fieldset>

      <fieldset className="automation-fieldset">
        <legend>Gate</legend>
        <label className="automation-checkbox">
          <input
            checked={gateEnabled}
            type="checkbox"
            onChange={(event) => {
              setGateEnabled(event.currentTarget.checked);
              setValidationError(undefined);
            }}
          />
          <span>Run script before starting</span>
        </label>
        {gateEnabled ? (
          <>
            <label className="automation-field">
              <span>Command</span>
              <input
                value={gateCommand}
                onChange={(event) => {
                  setGateCommand(event.currentTarget.value);
                  setValidationError(undefined);
                }}
              />
            </label>
            <div className="automation-inline-fields">
              <label className="automation-field">
                <span>Working directory</span>
                <input
                  value={gateCwd}
                  onChange={(event) => {
                    setGateCwd(event.currentTarget.value);
                    setValidationError(undefined);
                  }}
                />
              </label>
              <label className="automation-field">
                <span>Timeout ms</span>
                <input
                  min={1}
                  type="number"
                  value={gateTimeoutMs}
                  onChange={(event) => {
                    setGateTimeoutMs(event.currentTarget.value);
                    setValidationError(undefined);
                  }}
                />
              </label>
            </div>
          </>
        ) : null}
      </fieldset>

      <label className="automation-field">
        <span>Backlog</span>
        <select
          value={backlogPolicy}
          onChange={(event) =>
            setBacklogPolicy(event.currentTarget.value as AutomationBacklogPolicy)
          }
        >
          <option value="coalesce">Coalesce missed runs</option>
          <option value="drop_missed">Drop missed runs</option>
        </select>
      </label>

      <label className="automation-checkbox">
        <input
          checked={enabled}
          type="checkbox"
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />
        <span>Enabled</span>
      </label>

      {validationError ? (
        <p className="automation-editor__error" role="alert">
          {validationError}
        </p>
      ) : null}

      <div className="automation-editor__actions">
        <button className="button button--ghost" type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="button button--primary" disabled={props.saving} type="submit">
          {props.mode.kind === "edit" ? "Save" : "Create"}
        </button>
      </div>
    </form>
  );
}

function readInitialAssignment(props: AutomationEditorProps):
  | {
      backend: AppServerBackendKind;
      threadId: ThreadIdentifier;
    }
  | undefined {
  if (props.mode.kind === "edit") {
    return {
      backend: props.mode.automation.backend,
      threadId: props.mode.automation.threadId,
    };
  }
  return props.mode.assignment;
}

function shouldShowAgentPicker(props: AutomationEditorProps): boolean {
  return props.mode.kind === "edit" || !props.mode.assignment;
}

function buildThreadKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
): string {
  return buildThreadIdentityKey(backend, threadId);
}

function readAssignmentFromThreadKey(value: string):
  | {
      backend: AppServerBackendKind;
      threadId: ThreadIdentifier;
    }
  | undefined {
  return parseThreadIdentityKey(value);
}

function buildAgentOption(thread: NavigationThreadSummary): AgentThreadOption {
  return {
    key: buildThreadKey(thread.source, thread.id),
    label: thread.agent?.name ?? thread.title,
    meta: formatAgentThreadMeta(thread),
    thread,
    title: thread.title,
  };
}

function buildPromotedAgentOption(
  option: AgentThreadOption,
  assignment: {
    agent?: NavigationThreadSummary["agent"];
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  },
): AgentThreadOption {
  const thread = option.thread
    ? {
        ...option.thread,
        agent: assignment.agent ?? {
          instructionLineCount: 0,
          instructionsTooLong: false,
          name: option.thread.title,
          updatedAt: option.thread.updatedAt ?? 0,
        },
      }
    : undefined;
  return {
    ...option,
    key: buildThreadKey(assignment.backend, assignment.threadId),
    label: thread?.agent?.name ?? option.label,
    meta: thread ? formatAgentThreadMeta(thread) : option.meta,
    ...(thread ? { thread } : {}),
  };
}

function formatCurrentAssignmentLabel(
  thread: NavigationThreadSummary | undefined,
): string {
  return thread?.agent?.name ?? thread?.title ?? "Current assigned Agent";
}

function formatCurrentAssignmentMeta(threadId: ThreadIdentifier | undefined): string {
  if (!threadId) {
    return "Current assigned thread";
  }
  const suffix = threadId.length > 12 ? threadId.slice(-12) : threadId;
  return `Current assigned thread ...${suffix}`;
}

function formatAgentThreadMeta(thread: NavigationThreadSummary): string {
  const provider = thread.source.startsWith("acp:")
    ? thread.source.slice("acp:".length)
    : thread.source;
  return `${provider} - ${thread.title}`;
}

function filterAgentPickerOptions(
  options: AgentThreadOption[],
  query: string,
): AgentThreadOption[] {
  const trimmed = query.trim().toLowerCase();
  const ordered = [...options].sort(
    (left, right) => (right.thread?.updatedAt ?? 0) - (left.thread?.updatedAt ?? 0),
  );
  if (!trimmed) {
    return ordered;
  }
  return ordered.filter((option) => {
    const haystack = `${option.label} ${option.meta} ${option.title}`.toLowerCase();
    return haystack.includes(trimmed);
  });
}

function buildSchedule(params: {
  daysOfWeek: AutomationWeekday[];
  intervalEvery: string;
  intervalUnit: "minutes" | "hours";
  scheduleKind: ScheduleFormKind;
  timeOfDay: string;
}):
  | { ok: true; schedule: AutomationScheduleDefinition }
  | { error: string; ok: false } {
  if (params.scheduleKind === "interval") {
    const every = Number(params.intervalEvery);
    if (!Number.isInteger(every) || every < 1) {
      return { error: "Interval must be a whole number greater than zero.", ok: false };
    }
    return {
      ok: true,
      schedule: {
        every,
        kind: "interval",
        unit: params.intervalUnit,
      },
    };
  }

  const timeOfDay = parseTimeOfDay(params.timeOfDay);
  if (!timeOfDay) {
    return { error: "Choose a valid time.", ok: false };
  }

  if (params.scheduleKind === "weekdays") {
    return {
      ok: true,
      schedule: {
        kind: "weekdays",
        timeOfDay,
      },
    };
  }

  return {
    ok: true,
    schedule: {
      daysOfWeek: params.daysOfWeek,
      kind: "weekly",
      timeOfDay,
    },
  };
}

function buildGate(params: {
  command: string;
  cwd: string;
  enabled: boolean;
  timeoutMs: string;
}):
  | {
      gate: CreateAutomationRequest["gate"];
      ok: true;
    }
  | {
      error: string;
      ok: false;
    } {
  if (!params.enabled) {
    return { gate: undefined, ok: true };
  }
  const command = params.command.trim();
  if (!command) {
    return { error: "Gate command is required.", ok: false };
  }
  const timeoutMs = Number(params.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return { error: "Gate timeout must be a whole number greater than zero.", ok: false };
  }
  const cwd = params.cwd.trim();
  return {
    gate: {
      command,
      ...(cwd ? { cwd } : {}),
      timeoutMs,
    },
    ok: true,
  };
}

function parseTimeOfDay(value: string): { hour: number; minute: number } | undefined {
  const [hourValue, minuteValue] = value.split(":");
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return undefined;
  }
  return { hour, minute };
}
