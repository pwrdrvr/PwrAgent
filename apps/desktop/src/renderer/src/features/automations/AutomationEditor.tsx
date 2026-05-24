import { useMemo, useState } from "react";
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
  formatAutomationScheduleSummary,
  validateAutomationScheduleDefinition,
} from "@pwragent/shared";

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
  onSubmit: (submission: AutomationEditorSubmit) => Promise<void>;
  saving?: boolean;
  threads?: NavigationThreadSummary[];
};

type ScheduleFormKind = "interval" | "weekdays" | "weekly";

const DAY_LABELS: Record<AutomationWeekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

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
  const [threadKey, setThreadKey] = useState(
    initialThreadKey,
  );
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

  const threadOptions = useMemo(
    () => {
      const options = (props.threads ?? [])
        .filter((thread) => thread.agent)
        .map((thread) => ({
          key: buildThreadKey(thread.source, thread.id),
          label: thread.agent?.name ?? thread.title,
          title: thread.title,
        }));
      if (
        initialThreadKey &&
        !options.some((thread) => thread.key === initialThreadKey)
      ) {
        const currentThread = (props.threads ?? []).find(
          (thread) => buildThreadKey(thread.source, thread.id) === initialThreadKey,
        );
        options.unshift({
          key: initialThreadKey,
          label: `${currentThread?.title ?? initialAssignment?.threadId ?? "Current thread"} (current)`,
          title: currentThread?.title ?? "Current assigned thread",
        });
      }
      return options;
    },
    [initialAssignment?.threadId, initialThreadKey, props.threads],
  );
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
      setValidationError("Choose an Agent for this automation.");
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
        <label className="automation-field">
          <span>Agent</span>
          <select
            value={threadKey}
            onChange={(event) => {
              setThreadKey(event.currentTarget.value);
              setValidationError(undefined);
            }}
          >
            <option value="">Choose Agent</option>
            {threadOptions.map((thread) => (
              <option key={thread.key} title={thread.title} value={thread.key}>
                {thread.label}
              </option>
            ))}
          </select>
        </label>
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
  return `${backend}:${threadId}`;
}

function readAssignmentFromThreadKey(value: string):
  | {
      backend: AppServerBackendKind;
      threadId: ThreadIdentifier;
    }
  | undefined {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }

  return {
    backend: value.slice(0, separatorIndex) as AppServerBackendKind,
    threadId: value.slice(separatorIndex + 1),
  };
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
