import { useEffect, useId, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  AutomationBacklogPolicy,
  AutomationDetail,
  AutomationInboundMessageTriggerDefinition,
  AutomationInboundTextMatchMode,
  AutomationMessagingConversationSnapshot,
  AutomationScheduleDefinition,
  AutomationSourceMessageDestination,
  AutomationWeekday,
  CreateAutomationRequest,
  DesktopSettingsSnapshot,
  MessagingChannelKind,
  MessagingConversationKind,
  NavigationThreadSummary,
  ThreadExecutionMode,
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
import type { DesktopApi } from "../../lib/desktop-api";
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
  desktopApi?: DesktopApi;
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
type TriggerFormKind = "schedule" | "inbound_message";
type OptionalExecutionMode = "" | ThreadExecutionMode;
type AgentPickerTab = "agents" | "threads";
type ReplyDestination = AutomationSourceMessageDestination | "none";
type TelegramScope = "group" | "topic";

type AgentThreadOption = {
  key: string;
  label: string;
  meta: string;
  thread?: NavigationThreadSummary;
  title: string;
};

/** Human labels for every messaging provider that can host an inbound trigger. */
const INBOUND_PROVIDER_LABELS: Partial<Record<MessagingChannelKind, string>> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  mattermost: "Mattermost",
  feishu: "Feishu",
  line: "LINE",
};

/**
 * Fallback provider list used only when the desktop bridge cannot tell us which
 * providers are actually enabled (e.g. unit tests). In the real app the editor
 * gates the list to enabled providers read from settings.
 */
const DEFAULT_INBOUND_PROVIDERS: MessagingChannelKind[] = ["slack", "telegram"];

const MANUAL_GROUP_VALUE = "__manual__";

type ProviderGroups = Partial<
  Record<MessagingChannelKind, Array<{ id: string; title: string }>>
>;

const MODEL_OPTIONS = ["gpt-5", "gpt-5.4", "gpt-5.4-mini", "grok-4"] as const;
const REASONING_OPTIONS = ["low", "medium", "high", "xhigh"] as const;
const ACCESS_MODE_OPTIONS: Array<{ label: string; value: ThreadExecutionMode }> = [
  { label: "Default", value: "default" },
  { label: "Full Access", value: "full-access" },
];

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
  const initialInboundTrigger = initialAutomation?.triggers.find(
    (trigger): trigger is AutomationInboundMessageTriggerDefinition =>
      trigger.kind === "inbound_message",
  );
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
  const [triggerKind, setTriggerKind] = useState<TriggerFormKind>(
    initialInboundTrigger ? "inbound_message" : "schedule",
  );
  const initialConversation = initialInboundTrigger?.conversation;
  const initialIsTopic = initialConversation?.conversationKind === "topic";
  const [inboundProvider, setInboundProvider] = useState<MessagingChannelKind>(
    initialConversation?.channel ?? "telegram",
  );
  const [groupSelection, setGroupSelection] = useState<string>(
    initialConversation ? MANUAL_GROUP_VALUE : "",
  );
  const [inboundGroupId, setInboundGroupId] = useState(
    initialIsTopic
      ? initialConversation?.parentId ?? ""
      : initialConversation?.conversationId ?? "",
  );
  const [telegramScope, setTelegramScope] = useState<TelegramScope>(
    initialIsTopic ? "topic" : "group",
  );
  const [inboundTopicId, setInboundTopicId] = useState(
    initialIsTopic ? initialConversation?.conversationId ?? "" : "",
  );
  const [inboundSenderId, setInboundSenderId] = useState(
    initialInboundTrigger?.sender?.platformUserId ?? "",
  );
  const [inboundSenderScope, setInboundSenderScope] = useState<"" | "true" | "false">(
    initialInboundTrigger?.sender?.isBot === undefined
      ? ""
      : initialInboundTrigger.sender.isBot
        ? "true"
        : "false",
  );
  const [inboundText, setInboundText] = useState(
    initialInboundTrigger?.textFilter?.text ?? "",
  );
  const [inboundTextMode, setInboundTextMode] =
    useState<AutomationInboundTextMatchMode>(
      initialInboundTrigger?.textFilter?.mode ?? "contains",
    );
  const [inboundCaseSensitive, setInboundCaseSensitive] = useState(
    initialInboundTrigger?.textFilter?.caseSensitive ?? false,
  );
  const [inboundIncludeReplies, setInboundIncludeReplies] = useState(
    initialInboundTrigger?.includeThreadReplies ?? false,
  );
  const [replyDestination, setReplyDestination] = useState<ReplyDestination>(
    initialReplyDestination(initialAutomation),
  );
  const [sourceReplyBroadcast, setSourceReplyBroadcast] = useState(
    initialAutomation?.outputActions.some(
      (action) => action.kind === "source_message" && action.broadcast,
    ) ?? false,
  );
  const [profileCwd, setProfileCwd] = useState(
    initialAutomation?.executionProfile?.cwd ?? "",
  );
  const [profileModel, setProfileModel] = useState(
    initialAutomation?.executionProfile?.model ?? "",
  );
  const [profileReasoning, setProfileReasoning] = useState(
    initialAutomation?.executionProfile?.reasoningEffort ?? "",
  );
  const [profileExecutionMode, setProfileExecutionMode] =
    useState<OptionalExecutionMode>(
      initialAutomation?.executionProfile?.executionMode ?? "",
    );
  const [profileMcpAllowlist, setProfileMcpAllowlist] = useState(
    (initialAutomation?.executionProfile?.mcpAllowlist ?? []).join(", "),
  );
  const [profileToolAllowlist, setProfileToolAllowlist] = useState(
    (initialAutomation?.executionProfile?.toolAllowlist ?? []).join(", "),
  );
  const [enabledProviders, setEnabledProviders] = useState<MessagingChannelKind[]>();
  const [providerGroups, setProviderGroups] = useState<ProviderGroups>({});

  useEffect(() => {
    const readSettings = props.desktopApi?.readSettings;
    if (!readSettings) {
      setEnabledProviders(DEFAULT_INBOUND_PROVIDERS);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await readSettings();
        if (cancelled) return;
        setEnabledProviders(readEnabledProviders(response.snapshot));
        setProviderGroups(readProviderGroups(response.snapshot));
      } catch {
        if (!cancelled) setEnabledProviders(DEFAULT_INBOUND_PROVIDERS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.desktopApi]);

  const availableProviders =
    enabledProviders === undefined || enabledProviders.length === 0
      ? enabledProviders ?? DEFAULT_INBOUND_PROVIDERS
      : enabledProviders;
  const noProvidersEnabled =
    enabledProviders !== undefined && enabledProviders.length === 0;

  useEffect(() => {
    if (
      availableProviders.length > 0 &&
      !availableProviders.includes(inboundProvider)
    ) {
      setInboundProvider(availableProviders[0]);
    }
  }, [availableProviders, inboundProvider]);

  const telegramGroups = providerGroups[inboundProvider] ?? [];
  const selectedGroup = telegramGroups.find(
    (group) => group.id === groupSelection,
  );

  const [captureEntryId, setCaptureEntryId] = useState<string>();
  const [captureMessage, setCaptureMessage] = useState<string>();
  const [captureStatus, setCaptureStatus] = useState<
    "idle" | "waiting" | "captured" | "error"
  >("idle");
  const [captureError, setCaptureError] = useState<string>();
  const [capturedName, setCapturedName] = useState<string>();
  const [capturedGroupTitle, setCapturedGroupTitle] = useState<string>();
  const canCaptureByCode = Boolean(props.desktopApi?.generateMessagingPairingToken);

  const applyObservedChat = (chat: {
    bucketId?: string;
    id: string;
    kind: MessagingConversationKind;
    parentId?: string;
    parentTitle?: string;
    title?: string;
  }): void => {
    if (chat.kind === "topic") {
      setInboundGroupId(chat.bucketId ?? chat.parentId ?? "");
      setTelegramScope("topic");
      setInboundTopicId(chat.id);
      setCapturedGroupTitle(chat.parentTitle);
      setCapturedName(chat.title ?? chat.parentTitle ?? chat.id);
    } else {
      setInboundGroupId(chat.id);
      setTelegramScope("group");
      setInboundTopicId("");
      setCapturedGroupTitle(chat.title);
      setCapturedName(chat.title ?? chat.id);
    }
    setGroupSelection(MANUAL_GROUP_VALUE);
  };

  useEffect(() => {
    if (!captureEntryId) return;
    const subscribe = props.desktopApi?.onMessagingPairingChanged;
    const approve = props.desktopApi?.approveMessagingPairing;
    const readSettings = props.desktopApi?.readSettings;
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.entry.id !== captureEntryId) return;
      if (!event.entry.observedChat) return;
      const chat = event.entry.observedChat;
      applyObservedChat(chat);
      setCaptureStatus("captured");
      setCaptureMessage(undefined);
      setValidationError(undefined);
      // Authorize the conversation so the trigger can actually fire, then
      // refresh the known-group list so it appears in the picker.
      void (async () => {
        try {
          await approve?.({ entryId: event.entry.id });
          const response = await readSettings?.();
          if (response) {
            setProviderGroups(readProviderGroups(response.snapshot));
          }
        } catch {
          // Capture still succeeded; authorization can be completed in Settings.
        }
      })();
      setCaptureEntryId(undefined);
    });
  }, [captureEntryId, props.desktopApi]);

  const startCaptureByCode = async (): Promise<void> => {
    const generate = props.desktopApi?.generateMessagingPairingToken;
    if (!generate) return;
    setCaptureError(undefined);
    setCaptureStatus("waiting");
    setCapturedName(undefined);
    try {
      const result = await generate({ platform: inboundProvider, scope: "bucket" });
      setCaptureMessage(result.message);
      setCaptureEntryId(result.entry.id);
    } catch (caught) {
      setCaptureStatus("error");
      setCaptureError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const cancelCaptureByCode = (): void => {
    const entryId = captureEntryId;
    if (entryId) {
      void props.desktopApi?.rejectMessagingPairing?.({ entryId }).catch(() => {});
    }
    setCaptureEntryId(undefined);
    setCaptureMessage(undefined);
    setCaptureStatus("idle");
    setCaptureError(undefined);
  };

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
    if (triggerKind === "schedule" && !selectedSchedule.ok) {
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
    if (triggerKind === "schedule" && selectedSchedule.ok) {
      const scheduleValidation = validateAutomationScheduleDefinition(
        selectedSchedule.schedule,
      );
      if (!scheduleValidation.ok) {
        setValidationError(scheduleValidation.error);
        return;
      }
    }
    const triggerConfig = buildTriggerConfig({
      broadcast: sourceReplyBroadcast,
      caseSensitive: inboundCaseSensitive,
      groupId: inboundGroupId,
      groupTitle: selectedGroup?.title ?? capturedGroupTitle,
      includeThreadReplies: inboundIncludeReplies,
      provider: inboundProvider,
      replyDestination,
      schedule: selectedSchedule.ok ? selectedSchedule.schedule : undefined,
      senderId: inboundSenderId,
      senderScope: inboundSenderScope,
      telegramScope,
      text: inboundText,
      textMode: inboundTextMode,
      topicId: inboundTopicId,
      triggerKind,
    });
    if (!triggerConfig.ok) {
      setValidationError(triggerConfig.error);
      return;
    }
    const executionProfile = buildExecutionProfile({
      cwd: profileCwd,
      executionMode: profileExecutionMode,
      mcpAllowlist: profileMcpAllowlist,
      model: profileModel,
      reasoningEffort: profileReasoning,
      toolAllowlist: profileToolAllowlist,
    });

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
          executionProfile,
          gate: gate.gate,
          name: trimmedName,
          nextRunAt: triggerKind === "inbound_message" ? null : undefined,
          outputActions: triggerConfig.outputActions,
          schedule: triggerConfig.schedule,
          taskPrompt: trimmedPrompt,
          triggers: triggerConfig.triggers,
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
        executionProfile,
        gate: gate.gate,
        name: trimmedName,
        outputActions: triggerConfig.outputActions,
        schedule: triggerConfig.schedule,
        taskPrompt: trimmedPrompt,
        triggers: triggerConfig.triggers,
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
        <legend>Trigger</legend>
        <div className="automation-segmented" role="group" aria-label="Trigger kind">
          {([
            ["schedule", "Schedule"],
            ["inbound_message", "Inbound message"],
          ] as const).map(([kind, label]) => (
            <button
              key={kind}
              aria-pressed={triggerKind === kind}
              className={`automation-segmented__button${
                triggerKind === kind ? " is-active" : ""
              }`}
              type="button"
              onClick={() => {
                setTriggerKind(kind);
                setValidationError(undefined);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      {triggerKind === "schedule" ? (
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
      ) : (
        <fieldset className="automation-fieldset">
          <legend>Inbound filter</legend>
          <p className="automation-editor__callout">
            Each matching inbound message starts an isolated background run for
            this automation. The run is queued with the target Agent, writes its
            analysis back into Agent context, and can optionally reply where the
            triggering message arrived so recent instances can be compared later.
          </p>
          {noProvidersEnabled ? (
            <p className="automation-editor__error" role="alert">
              No messaging providers are enabled. Enable one in Settings &gt;
              Messaging before creating an inbound trigger.
            </p>
          ) : null}
          <div className="automation-inline-fields">
            <label className="automation-field">
              <span>Provider</span>
              <select
                value={inboundProvider}
                onChange={(event) => {
                  setInboundProvider(
                    event.currentTarget.value as MessagingChannelKind,
                  );
                  setGroupSelection("");
                  setInboundGroupId("");
                  setValidationError(undefined);
                }}
              >
                {availableProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {INBOUND_PROVIDER_LABELS[provider] ?? provider}
                  </option>
                ))}
              </select>
            </label>
            {inboundProvider === "telegram" && telegramGroups.length > 0 ? (
              <label className="automation-field">
                <span>Group</span>
                <select
                  value={groupSelection}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setGroupSelection(value);
                    setInboundGroupId(value === MANUAL_GROUP_VALUE ? "" : value);
                    setValidationError(undefined);
                  }}
                >
                  <option value="">Choose a group</option>
                  {telegramGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.title}
                    </option>
                  ))}
                  <option value={MANUAL_GROUP_VALUE}>
                    Enter group ID manually...
                  </option>
                </select>
              </label>
            ) : null}
          </div>

          {inboundProvider === "telegram" ? (
            telegramGroups.length === 0 ||
            groupSelection === MANUAL_GROUP_VALUE ? (
              <div className="automation-field-group">
                <label className="automation-field">
                  <span>Group ID</span>
                  <input
                    placeholder="-1001234567890"
                    value={inboundGroupId}
                    onChange={(event) => {
                      setInboundGroupId(event.currentTarget.value);
                      setValidationError(undefined);
                    }}
                  />
                </label>
                <p className="automation-field__hint">
                  The supergroup ID (a negative number). Add the bot to the group
                  and pair it from Settings &gt; Messaging, then pick it above.
                </p>
              </div>
            ) : null
          ) : (
            <div className="automation-field-group">
              <label className="automation-field">
                <span>{conversationLabel(inboundProvider)}</span>
                <input
                  placeholder={conversationPlaceholder(inboundProvider)}
                  value={inboundGroupId}
                  onChange={(event) => {
                    setInboundGroupId(event.currentTarget.value);
                    setValidationError(undefined);
                  }}
                />
              </label>
              <p className="automation-field__hint">
                {conversationHint(inboundProvider)}
              </p>
            </div>
          )}

          {canCaptureByCode ? (
            <div className="automation-capture">
              {captureStatus === "idle" || captureStatus === "error" ? (
                <button
                  className="button button--ghost automation-capture__start"
                  type="button"
                  onClick={() => void startCaptureByCode()}
                >
                  Not sure of the ID? Register with a code
                </button>
              ) : null}
              {captureStatus === "waiting" ? (
                <div className="automation-capture__panel" role="status">
                  <p className="automation-capture__lead">
                    Paste this into the{" "}
                    {inboundProvider === "telegram"
                      ? "group or topic"
                      : "channel"}{" "}
                    you want to watch. PwrAgent will detect it and fill in the
                    details.
                  </p>
                  {captureMessage ? (
                    <pre className="automation-capture__code">{captureMessage}</pre>
                  ) : null}
                  <div className="automation-capture__actions">
                    <span className="automation-capture__waiting">
                      Waiting for the code to arrive...
                    </span>
                    <button
                      className="button button--ghost"
                      type="button"
                      onClick={cancelCaptureByCode}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {captureStatus === "captured" ? (
                <p className="automation-capture__captured" role="status">
                  Captured {capturedName ?? "the conversation"} and authorized it.
                  The fields above are filled in.
                </p>
              ) : null}
              {captureStatus === "error" && captureError ? (
                <p className="automation-editor__error" role="alert">
                  {captureError}
                </p>
              ) : null}
            </div>
          ) : null}

          {inboundProvider === "telegram" ? (
            <>
              <div
                aria-label="Telegram scope"
                className="automation-segmented"
                role="group"
              >
                {([
                  ["group", "Whole group"],
                  ["topic", "Specific topic"],
                ] as const).map(([scope, label]) => (
                  <button
                    key={scope}
                    aria-pressed={telegramScope === scope}
                    className={`automation-segmented__button${
                      telegramScope === scope ? " is-active" : ""
                    }`}
                    type="button"
                    onClick={() => {
                      setTelegramScope(scope);
                      setValidationError(undefined);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {telegramScope === "topic" ? (
                <div className="automation-field-group">
                  <label className="automation-field">
                    <span>Topic ID</span>
                    <input
                      placeholder="42"
                      value={inboundTopicId}
                      onChange={(event) => {
                        setInboundTopicId(event.currentTarget.value);
                        setValidationError(undefined);
                      }}
                    />
                  </label>
                  <p className="automation-field__hint">
                    The forum topic's numeric ID. Keep "Whole group" to watch
                    every topic in the group.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="automation-inline-fields">
            <label className="automation-field">
              <span>Sender type</span>
              <select
                value={inboundSenderScope}
                onChange={(event) => {
                  setInboundSenderScope(
                    event.currentTarget.value as "" | "true" | "false",
                  );
                  setValidationError(undefined);
                }}
              >
                <option value="">Any sender</option>
                <option value="true">Bots only</option>
                <option value="false">People only</option>
              </select>
            </label>
            <label className="automation-field">
              <span>Sender ID (optional)</span>
              <input
                placeholder={inboundProvider === "telegram" ? "123456" : "U0123 / B0123"}
                value={inboundSenderId}
                onChange={(event) => {
                  setInboundSenderId(event.currentTarget.value);
                  setValidationError(undefined);
                }}
              />
            </label>
          </div>

          <div className="automation-inline-fields">
            <label className="automation-field">
              <span>Match mode</span>
              <select
                value={inboundTextMode}
                onChange={(event) => {
                  setInboundTextMode(
                    event.currentTarget.value as AutomationInboundTextMatchMode,
                  );
                  setValidationError(undefined);
                }}
              >
                <option value="contains">Text contains</option>
                <option value="equals">Text equals</option>
              </select>
            </label>
            <label className="automation-field">
              <span>{inboundTextMode === "equals" ? "Text equals" : "Text contains"}</span>
              <input
                placeholder="ERROR"
                value={inboundText}
                onChange={(event) => {
                  setInboundText(event.currentTarget.value);
                  setValidationError(undefined);
                }}
              />
            </label>
          </div>
          <label className="automation-checkbox">
            <input
              checked={inboundCaseSensitive}
              type="checkbox"
              onChange={(event) => setInboundCaseSensitive(event.currentTarget.checked)}
            />
            <span>Case sensitive</span>
          </label>
          {inboundProvider !== "telegram" ? (
            <label className="automation-checkbox">
              <input
                checked={inboundIncludeReplies}
                type="checkbox"
                onChange={(event) =>
                  setInboundIncludeReplies(event.currentTarget.checked)
                }
              />
              <span>Include thread replies</span>
            </label>
          ) : null}

          <div className="automation-field-group">
            <label className="automation-field">
              <span>Reply</span>
              <select
                value={replyDestination}
                onChange={(event) => {
                  setReplyDestination(event.currentTarget.value as ReplyDestination);
                  setValidationError(undefined);
                }}
              >
                <option value="source_thread">{replyThreadLabel(inboundProvider)}</option>
                <option value="source_channel">{replyChannelLabel(inboundProvider)}</option>
                <option value="none">Don't reply (Agent context only)</option>
              </select>
            </label>
            <p className="automation-field__hint">
              The Agent thread always receives the analysis as context. This only
              controls whether PwrAgent also posts a reply where the message
              arrived.
            </p>
          </div>
          {replyDestination !== "none" && inboundProvider === "slack" ? (
            <label className="automation-checkbox">
              <input
                checked={sourceReplyBroadcast}
                type="checkbox"
                onChange={(event) => setSourceReplyBroadcast(event.currentTarget.checked)}
              />
              <span>Also broadcast the reply to the channel</span>
            </label>
          ) : null}
        </fieldset>
      )}

      <fieldset className="automation-fieldset">
        <legend>Execution</legend>
        <div className="automation-inline-fields automation-inline-fields--single">
          <label className="automation-field">
            <span>Agent working directory</span>
            <input
              value={profileCwd}
              onChange={(event) => setProfileCwd(event.currentTarget.value)}
            />
          </label>
        </div>
        <div className="automation-inline-fields">
          <label className="automation-field">
            <span>Access mode</span>
            <select
              value={profileExecutionMode}
              onChange={(event) =>
                setProfileExecutionMode(event.currentTarget.value as OptionalExecutionMode)
              }
            >
              <option value="">Inherit Agent access</option>
              {ACCESS_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="automation-field">
            <span>Model</span>
            <select
              value={profileModel}
              onChange={(event) => setProfileModel(event.currentTarget.value)}
            >
              <option value="">Inherit Agent model</option>
              {modelOptions(profileModel).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="automation-inline-fields automation-inline-fields--single">
          <label className="automation-field">
            <span>Reasoning</span>
            <select
              value={profileReasoning}
              onChange={(event) => setProfileReasoning(event.currentTarget.value)}
            >
              <option value="">Inherit Agent reasoning</option>
              {reasoningOptions(profileReasoning).map((reasoning) => (
                <option key={reasoning} value={reasoning}>
                  {reasoning}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="automation-field-group">
          <label className="automation-field">
            <span>Allowed MCP servers</span>
            <input
              placeholder="datadog, aws-readonly"
              value={profileMcpAllowlist}
              onChange={(event) => setProfileMcpAllowlist(event.currentTarget.value)}
            />
          </label>
          <p className="automation-field__hint">
            Comma-separated MCP server names this run may use to fetch data.
            Leave blank to inherit the Agent's MCP servers.
          </p>
        </div>
        <div className="automation-field-group">
          <label className="automation-field">
            <span>Allowed tools</span>
            <input
              placeholder="read_file, run_command"
              value={profileToolAllowlist}
              onChange={(event) => setProfileToolAllowlist(event.currentTarget.value)}
            />
          </label>
          <p className="automation-field__hint">
            Comma-separated tool names. Leave blank to inherit the Agent's tools.
          </p>
        </div>
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
                <span>Gate working directory</span>
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

function buildExecutionProfile(params: {
  cwd: string;
  executionMode: OptionalExecutionMode;
  mcpAllowlist: string;
  model: string;
  reasoningEffort: string;
  toolAllowlist: string;
}): CreateAutomationRequest["executionProfile"] {
  const cwd = params.cwd.trim();
  const model = params.model.trim();
  const reasoningEffort = params.reasoningEffort.trim();
  const mcpAllowlist = parseAllowlist(params.mcpAllowlist);
  const toolAllowlist = parseAllowlist(params.toolAllowlist);
  if (
    !cwd &&
    !params.executionMode &&
    !model &&
    !reasoningEffort &&
    mcpAllowlist.length === 0 &&
    toolAllowlist.length === 0
  ) {
    return undefined;
  }
  return {
    ...(cwd ? { cwd } : {}),
    ...(params.executionMode ? { executionMode: params.executionMode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(mcpAllowlist.length > 0 ? { mcpAllowlist } : {}),
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
  };
}

function parseAllowlist(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function modelOptions(current: string): string[] {
  return includeCurrentOption(MODEL_OPTIONS, current);
}

function reasoningOptions(current: string): string[] {
  return includeCurrentOption(REASONING_OPTIONS, current);
}

function includeCurrentOption(
  options: readonly string[],
  current: string,
): string[] {
  const trimmed = current.trim();
  return trimmed && !options.includes(trimmed)
    ? [trimmed, ...options]
    : [...options];
}

function buildTriggerConfig(params: {
  broadcast: boolean;
  caseSensitive: boolean;
  groupId: string;
  groupTitle?: string;
  includeThreadReplies: boolean;
  provider: MessagingChannelKind;
  replyDestination: ReplyDestination;
  schedule?: AutomationScheduleDefinition;
  senderId: string;
  senderScope: "" | "true" | "false";
  telegramScope: TelegramScope;
  text: string;
  textMode: AutomationInboundTextMatchMode;
  topicId: string;
  triggerKind: TriggerFormKind;
}):
  | {
      ok: true;
      outputActions: CreateAutomationRequest["outputActions"];
      schedule?: AutomationScheduleDefinition;
      triggers: CreateAutomationRequest["triggers"];
    }
  | { error: string; ok: false } {
  if (params.triggerKind === "schedule") {
    if (!params.schedule) {
      return { error: "Choose a valid schedule.", ok: false };
    }
    return {
      ok: true,
      outputActions: [{ id: "agent-context", kind: "agent_context" }],
      schedule: params.schedule,
      triggers: [
        {
          id: "schedule",
          kind: "schedule",
          schedule: params.schedule,
        },
      ],
    };
  }

  const groupId = params.groupId.trim();
  const topicId = params.topicId.trim();
  const senderId = params.senderId.trim();
  const text = params.text.trim();
  const isTopic =
    params.provider === "telegram" && params.telegramScope === "topic";
  if (!groupId) {
    return {
      error:
        params.provider === "telegram"
          ? "Choose a group or enter a group ID."
          : "Conversation ID is required.",
      ok: false,
    };
  }
  if (isTopic && !topicId) {
    return { error: "Enter a topic ID or switch to Whole group.", ok: false };
  }
  if (!text) {
    return {
      error: "A text filter keeps the trigger from matching every message.",
      ok: false,
    };
  }

  const conversation: AutomationMessagingConversationSnapshot = isTopic
    ? {
        channel: params.provider,
        conversationId: topicId,
        conversationKind: "topic",
        parentId: groupId,
        ...(params.groupTitle ? { parentTitle: params.groupTitle } : {}),
      }
    : {
        channel: params.provider,
        conversationId: groupId,
        conversationKind: "channel",
        ...(params.groupTitle ? { title: params.groupTitle } : {}),
      };

  const sender =
    params.senderScope === "" && !senderId
      ? undefined
      : {
          ...(params.senderScope !== ""
            ? { isBot: params.senderScope === "true" }
            : {}),
          ...(senderId ? { platformUserId: senderId } : {}),
        };

  const outputActions: NonNullable<CreateAutomationRequest["outputActions"]> = [
    { id: "agent-context", kind: "agent_context" },
  ];
  if (params.replyDestination !== "none") {
    outputActions.push({
      broadcast: params.broadcast,
      destination: params.replyDestination,
      id: "source-thread-reply",
      kind: "source_message",
    });
  }

  return {
    ok: true,
    outputActions,
    triggers: [
      {
        conversation,
        id: "inbound-message",
        includeThreadReplies: params.includeThreadReplies,
        kind: "inbound_message",
        name: text,
        ...(sender ? { sender } : {}),
        textFilter: {
          mode: params.textMode,
          text,
          ...(params.caseSensitive ? { caseSensitive: true } : {}),
        },
      },
    ],
  };
}

function conversationLabel(provider: MessagingChannelKind): string {
  if (provider === "slack") return "Channel ID";
  if (provider === "discord") return "Channel ID";
  return "Conversation ID";
}

function conversationPlaceholder(provider: MessagingChannelKind): string {
  if (provider === "slack") return "C0123ABCD";
  if (provider === "discord") return "123456789012345678";
  return "";
}

function conversationHint(provider: MessagingChannelKind): string {
  if (provider === "slack") {
    return "The Slack channel ID. In Slack, open the channel details and copy the ID at the bottom, or copy a message link and take the C... segment.";
  }
  if (provider === "discord") {
    return "The Discord channel ID. Enable Developer Mode, then right-click the channel and Copy Channel ID.";
  }
  return "The conversation ID PwrAgent should watch.";
}

function replyThreadLabel(provider: MessagingChannelKind): string {
  if (provider === "telegram") return "Reply in the same topic";
  return "Reply in the source thread";
}

function replyChannelLabel(provider: MessagingChannelKind): string {
  if (provider === "telegram") return "Reply at the group level";
  return "Reply in the channel";
}

function initialReplyDestination(
  automation: AutomationDetail | undefined,
): ReplyDestination {
  if (!automation) return "source_thread";
  const source = automation.outputActions.find(
    (action) => action.kind === "source_message",
  );
  return source && source.kind === "source_message" ? source.destination : "none";
}

function readEnabledProviders(
  snapshot: DesktopSettingsSnapshot,
): MessagingChannelKind[] {
  const messaging = snapshot.messaging;
  const providers: MessagingChannelKind[] = [];
  if (messaging.telegram.enabled.value) providers.push("telegram");
  if (messaging.slack.enabled.value) providers.push("slack");
  if (messaging.discord.enabled.value) providers.push("discord");
  if (messaging.mattermost.enabled.value) providers.push("mattermost");
  if (messaging.feishu.enabled.value) providers.push("feishu");
  if (messaging.line.enabled.value) providers.push("line");
  return providers;
}

function readProviderGroups(snapshot: DesktopSettingsSnapshot): ProviderGroups {
  const telegram = snapshot.messaging.telegram.authorizedSupergroups.value.map(
    (contact) => ({
      id: contact.id,
      title: contact.displayName ? `${contact.displayName}` : contact.id,
    }),
  );
  return telegram.length > 0 ? { telegram } : {};
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
