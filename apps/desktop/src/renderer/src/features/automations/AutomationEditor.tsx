import { matchesAutomationConversation } from "@pwragent/shared";
import type { NavigationDirectoryView as NavigationDirectorySummary } from "../../lib/navigation-loaded-rows";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  AppServerBackendKind,
  AutomationBacklogPolicy,
  AutomationDetail,
  AutomationInboundConditionGroup,
  AutomationInboundMessageTriggerDefinition,
  AutomationMessagingConversationSnapshot,
  AutomationScheduleDefinition,
  BackendSummary,
  AutomationSourceMessageDestination,
  AutomationWeekday,
  CreateAutomationRequest,
  DesktopMessagingSettingsProjection,
  InboundPreviewMessage,
  InboundTopicOption,
  ListDiscordThreadPermissionChannelsResponse,
  MessagingChannelKind,
  MessagingConversationKind,
  MessagingSenderSuggestion,
  NavigationThreadSummary,
  ThreadExecutionMode,
  ThreadIdentifier,
  UpdateAutomationRequest,
} from "@pwragent/shared";
import {
  AUTOMATION_RUN_RATE_PER_HOUR_OPTIONS,
  AUTOMATION_WEEKDAYS,
  DEFAULT_AUTOMATION_MAX_RUNS_PER_HOUR,
  automationConversationKey,
  buildAutomationInboundTriggerId,
  buildThreadIdentityKey,
  evaluateAutomationInboundConditions,
  findAutomationConversationIndexForMessage,
  formatAutomationConversationLabel,
  formatAutomationConversationList,
  formatAutomationInboundConditionGroup,
  formatAutomationScheduleSummary,
  normalizeInboundTriggerConditions,
  parseThreadIdentityKey,
  validateAutomationScheduleDefinition,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { MessagingSurfacePicker } from "../../components/MessagingSurfacePicker";
import {
  CODEX_AGENT_THREAD_CREATION_NOTE,
  canChangeExistingThreadAgentDesignation,
} from "../../lib/agent-thread";
import { copyText } from "../../lib/copy-text";
import { HelpCircleIcon } from "../../icons";
import { AutomationConditionEditor } from "./AutomationConditionEditor";
import { formatAutomationRelative } from "./automation-format";
import { AutomationMcpPicker } from "./AutomationMcpPicker";
import { ProjectPicker } from "../composer/ProjectPicker";
import { ComposerDropdown } from "../composer/ComposerDropdown";
import { AutomationFlow, AutomationStage } from "./AutomationFunnel";

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
  /** Tracked project directories, for the working-directory picker. */
  directories?: NavigationDirectorySummary[];
};

type ScheduleFormKind = "interval" | "weekdays" | "weekly";
type TriggerFormKind = "schedule" | "inbound_message";
type OptionalExecutionMode = "" | ThreadExecutionMode;
type AgentPickerTab = "agents" | "threads";
type ResultMode = "reply_source" | "different" | "agent_only";
type TelegramScope = "group" | "topic";

type AgentThreadOption = {
  key: string;
  label: string;
  meta: string;
  thread?: NavigationThreadSummary;
  title: string;
};

/** Human labels for every messaging provider that can host an inbound trigger. */
export const INBOUND_PROVIDER_LABELS: Partial<Record<MessagingChannelKind, string>> = {
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

type ProviderConversation = {
  id: string;
  title: string;
  kind: MessagingConversationKind;
};

type ProviderGroups = Partial<Record<MessagingChannelKind, ProviderConversation[]>>;

/** An authorized Discord server, from the settings snapshot. */
type DiscordServer = { id: string; name?: string };

/**
 * Channels listed from Discord's API for the authorized servers. `key` is the
 * server set it was listed for, so authorizing another server lists again.
 */
type DiscordChannelCatalog = {
  key: string;
  channels: ProviderConversation[];
  /** One sentence per server whose channels Discord would not list. */
  issues: string[];
};

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
  // Every inbound trigger, not just the first: an automation can watch several
  // conversations, and a form that read back only one would drop the rest on
  // the next save. The first fills the conversation fields; the others become
  // the "Also watching" sources. They share one filter — this editor has only
  // ever written the same filter to every source — so the first trigger's
  // filter is the automation's filter.
  const initialInboundTriggers = (initialAutomation?.triggers ?? []).filter(
    (trigger): trigger is AutomationInboundMessageTriggerDefinition =>
      trigger.kind === "inbound_message",
  );
  const initialInboundTrigger = initialInboundTriggers[0];
  const initialSchedule = initialAutomation?.schedule;
  const initialAssignment = readInitialAssignment(props);
  const initialThreadKey = initialAssignment
    ? buildThreadKey(initialAssignment.backend, initialAssignment.threadId)
    : "";
  const [name, setName] = useState(initialAutomation?.name ?? "");
  const [taskPrompt, setTaskPrompt] = useState(initialAutomation?.taskPrompt ?? "");
  const [promptHelpOpen, setPromptHelpOpen] = useState(false);
  const [promptDraftOpen, setPromptDraftOpen] = useState(false);
  const [promptDescription, setPromptDescription] = useState("");
  const [promptDrafting, setPromptDrafting] = useState(false);
  const [promptDraftError, setPromptDraftError] = useState<string>();
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
  const watchingLabelId = useId();
  const promptLabelId = useId();
  const promptHelpId = useId();
  const canDeferAgent = props.mode.kind === "create";
  const canDraftPrompt = Boolean(props.desktopApi?.draftAutomationPrompt);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (validationError && typeof errorRef.current?.scrollIntoView === "function") {
      errorRef.current.scrollIntoView({ block: "center" });
    }
  }, [validationError]);
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
      : initialConversation?.recipientUserId
        ? contactSelection(initialConversation.recipientUserId)
        : initialConversation?.conversationId ?? "",
  );
  // Manual entry has to be able to say which KIND of surface an ID names; a
  // typed ID alone cannot. `D0481KQ9ZLA` is a Slack DM and `C04KJ8ZB2QT` a
  // channel, and a DM saved as a channel is rejected by the matcher for every
  // message it ever sees — an automation that looks saved and enabled and
  // never runs. The switch writes the same `dm:` form the picker produces, so
  // nothing downstream learns a second encoding.
  const [inboundManualKind, setInboundManualKind] = useState<ManualSurfaceKind>(
    initialConversation?.recipientUserId ? "dm" : "channel",
  );
  const [telegramScope, setTelegramScope] = useState<TelegramScope>(
    initialIsTopic ? "topic" : "group",
  );
  const [inboundTopicId, setInboundTopicId] = useState(
    initialIsTopic ? initialConversation?.conversationId ?? "" : "",
  );
  // The sources NOT open in the conversation fields, in list order, and where
  // the one that is open sits among them. The fields edit one source at a
  // time; picking a listed source swaps it in, so every source stays editable.
  const [extraSources, setExtraSources] = useState<
    AutomationMessagingConversationSnapshot[]
  >(() =>
    dedupeConversations(
      initialInboundTriggers.slice(1).map((trigger) => trigger.conversation),
    ),
  );
  const [editingIndex, setEditingIndex] = useState(0);
  // The stored source the fields were last loaded from, whose titles keep
  // naming it while the fields still point at it.
  const [fieldOrigin, setFieldOrigin] = useState<
    AutomationMessagingConversationSnapshot | undefined
  >(initialConversation);
  // Editing an automation written before condition lists existed converts its
  // legacy sender/text filters forward, so the operator sees the same filter
  // they configured — just expressed as rows.
  const [inboundConditions, setInboundConditions] =
    useState<AutomationInboundConditionGroup>(() =>
      initialInboundTrigger
        ? normalizeInboundTriggerConditions(initialInboundTrigger)
        : {
            join: "all",
            conditions: [
              {
                id: "condition-initial",
                field: "message_text",
                operator: "contains",
                values: [""],
              },
            ],
          },
    );
  // Seeded from the persisted valueLabels so reopening the editor shows
  // "datadog", not the opaque platform id captured at selection time.
  const [senderLabels, setSenderLabels] = useState<Record<string, string>>(() => {
    if (!initialInboundTrigger) return {};
    const labels: Record<string, string> = {};
    for (const condition of normalizeInboundTriggerConditions(initialInboundTrigger)
      .conditions) {
      for (const [value, label] of Object.entries(condition.valueLabels ?? {})) {
        labels[value] = label;
      }
    }
    return labels;
  });
  const [inboundIncludeReplies, setInboundIncludeReplies] = useState(
    initialInboundTrigger?.includeThreadReplies ?? false,
  );
  const [coalesceWindowSeconds, setCoalesceWindowSeconds] = useState(
    initialAutomation?.inboundCoalesceWindowMs !== undefined
      ? String(Math.round(initialAutomation.inboundCoalesceWindowMs / 1000))
      : "60",
  );
  const [maxRunsPerHour, setMaxRunsPerHour] = useState(
    initialAutomation?.maxRunsPerHour === null
      ? "unlimited"
      : initialAutomation?.maxRunsPerHour !== undefined
        ? String(initialAutomation.maxRunsPerHour)
        : String(DEFAULT_AUTOMATION_MAX_RUNS_PER_HOUR),
  );
  const runRateOptions = useMemo(() => {
    const options = AUTOMATION_RUN_RATE_PER_HOUR_OPTIONS.map(String);
    if (maxRunsPerHour !== "unlimited" && !options.includes(maxRunsPerHour)) {
      options.unshift(maxRunsPerHour);
    }
    return options;
  }, [maxRunsPerHour]);
  const initialTarget = initialAutomation?.outputActions.find(
    (action) => action.kind === "messaging_target",
  );
  const initialTargetSnapshot =
    initialTarget?.kind === "messaging_target" ? initialTarget.target : undefined;
  const initialTargetIsTopic =
    initialTargetSnapshot?.conversationKind === "topic";
  const [resultMode, setResultMode] = useState<ResultMode>(
    initialResultMode(initialAutomation),
  );
  const [replyDestination, setReplyDestination] =
    useState<AutomationSourceMessageDestination>(
      initialReplySubDestination(initialAutomation),
    );
  const [sourceReplyBroadcast, setSourceReplyBroadcast] = useState(
    initialAutomation?.outputActions.some(
      (action) => action.kind === "source_message" && action.broadcast,
    ) ?? false,
  );
  const [destProvider, setDestProvider] = useState<MessagingChannelKind>(
    initialTargetSnapshot?.channel ?? initialConversation?.channel ?? "telegram",
  );
  const [destGroupSelection, setDestGroupSelection] = useState<string>(
    initialTargetSnapshot ? MANUAL_GROUP_VALUE : "",
  );
  const [destGroupId, setDestGroupId] = useState(
    initialTargetIsTopic
      ? initialTargetSnapshot?.parentId ?? ""
      : initialTargetSnapshot?.recipientUserId
        ? contactSelection(initialTargetSnapshot.recipientUserId)
        : initialTargetSnapshot?.conversationId ?? "",
  );
  const [destManualKind, setDestManualKind] = useState<ManualSurfaceKind>(
    initialTargetSnapshot?.recipientUserId ? "dm" : "channel",
  );
  const [destTopicId, setDestTopicId] = useState(
    initialTargetIsTopic ? initialTargetSnapshot?.conversationId ?? "" : "",
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
  const [profileBackend, setProfileBackend] = useState<"" | AppServerBackendKind>(
    initialAutomation?.executionProfile?.backend ?? "",
  );
  const [profileMcpAllowlist, setProfileMcpAllowlist] = useState<string[]>(
    initialAutomation?.executionProfile?.mcpAllowlist ?? [],
  );
  const initialLookback = initialAutomation?.priorRunLookback;
  const [lookbackEnabled, setLookbackEnabled] = useState(Boolean(initialLookback));
  const [lookbackRuns, setLookbackRuns] = useState(
    String(initialLookback?.maxRuns ?? 5),
  );
  // "" = no age bound (count-only lookback).
  const [lookbackAgeMs, setLookbackAgeMs] = useState(
    initialLookback
      ? initialLookback.maxAgeMs !== undefined
        ? String(initialLookback.maxAgeMs)
        : ""
      : String(60 * 60 * 1000),
  );
  const [backendCatalog, setBackendCatalog] = useState<BackendSummary[]>();
  const [profileToolAllowlist, setProfileToolAllowlist] = useState(
    (initialAutomation?.executionProfile?.toolAllowlist ?? []).join(", "),
  );
  const [enabledProviders, setEnabledProviders] = useState<MessagingChannelKind[]>();
  const [providerGroups, setProviderGroups] = useState<ProviderGroups>({});
  const [discordServers, setDiscordServers] = useState<DiscordServer[]>();
  const [discordCatalog, setDiscordCatalog] = useState<DiscordChannelCatalog>();

  // The same backend catalog the composer reads: providers, their model lists,
  // and per-model reasoning efforts. Fetched once per editor mount.
  useEffect(() => {
    const list = props.desktopApi?.listBackends;
    if (!list) return;
    let cancelled = false;
    void list({})
      .then((response) => {
        if (!cancelled) setBackendCatalog(response.backends);
      })
      .catch(() => {
        // Selects degrade to free inherit-only choices; saving still works.
      });
    return () => {
      cancelled = true;
    };
  }, [props.desktopApi]);

  useEffect(() => {
    const desktopApi = props.desktopApi;
    const readMessagingSettings = desktopApi?.readMessagingSettings;
    if (!readMessagingSettings) {
      setEnabledProviders(DEFAULT_INBOUND_PROVIDERS);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await readMessagingSettings();
        if (cancelled) return;
        setEnabledProviders(readEnabledProviders(response.snapshot));
        setProviderGroups(readProviderGroups(response.snapshot));
        setDiscordServers(readDiscordServers(response.snapshot));
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
    // Not until the enabled list has actually loaded. Before it does,
    // `availableProviders` is the Slack/Telegram placeholder, and correcting
    // against that moved every saved Discord, Mattermost, Feishu, or LINE
    // trigger onto Slack on open — Save then wrote a Slack trigger holding the
    // original provider's conversation ID.
    if (enabledProviders === undefined) return;
    if (
      availableProviders.length > 0 &&
      !availableProviders.includes(inboundProvider)
    ) {
      setInboundProvider(availableProviders[0]);
    }
  }, [availableProviders, enabledProviders, inboundProvider]);

  // The destination needs the same correction, and never had it. Its default
  // ("telegram", or the trigger's platform) may not be enabled, and a
  // controlled select whose value matches no option DISPLAYS its first option
  // while the state stays put — so the form showed "Slack", and a Slack
  // channel ID typed under it saved as a Telegram target. Follow the trigger's
  // provider when it is enabled. Only without a saved destination: silently
  // moving a saved target to another platform would be the same bug.
  useEffect(() => {
    // Same wait as the trigger side, for the same reason: the placeholder
    // list would move a default that the real list allows.
    if (enabledProviders === undefined || initialTargetSnapshot) return;
    if (availableProviders.length === 0 || availableProviders.includes(destProvider)) {
      return;
    }
    setDestProvider(
      availableProviders.includes(inboundProvider) ? inboundProvider : availableProviders[0],
    );
    setDestGroupSelection("");
    setDestGroupId("");
    setDestTopicId("");
  }, [availableProviders, destProvider, enabledProviders, inboundProvider, initialTargetSnapshot]);

  // Discord authorizes servers, not channels, so the settings snapshot has no
  // channel list to read. The channels come from Discord itself, through the
  // same lister Messaging Settings uses to inspect thread permissions: it
  // returns a server's text and announcement channels — the two kinds that
  // carry ordinary messages — named, categorized, and validated. Listed only
  // once Discord is chosen on either side, since each server costs a request.
  const discordWanted = inboundProvider === "discord" || destProvider === "discord";
  const discordServerKey = discordServers?.map((server) => server.id).join(",");
  useEffect(() => {
    const list = props.desktopApi?.listDiscordThreadPermissionChannels;
    if (!discordWanted || !list || !discordServers || discordServerKey === undefined) {
      return;
    }
    if (discordCatalog?.key === discordServerKey) return;
    let cancelled = false;
    void Promise.all(
      discordServers.map(async (server) => {
        try {
          return { server, response: await list({ guildId: server.id }) };
        } catch (error) {
          return {
            server,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    ).then((results) => {
      if (!cancelled) {
        setDiscordCatalog(buildDiscordChannelCatalog(discordServerKey, results));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    discordCatalog?.key,
    discordServerKey,
    discordServers,
    discordWanted,
    props.desktopApi,
  ]);

  const catalogGroups = useMemo<ProviderGroups>(
    () =>
      discordCatalog?.channels.length
        ? {
            ...providerGroups,
            discord: [...discordCatalog.channels, ...(providerGroups.discord ?? [])],
          }
        : providerGroups,
    [discordCatalog, providerGroups],
  );

  const telegramGroups = catalogGroups[inboundProvider] ?? [];
  const selectedGroup = telegramGroups.find(
    (group) => group.id === groupSelection,
  );

  // Same reconciliation the destination picker does below: `groupSelection`
  // starts at MANUAL_GROUP_VALUE when editing (the catalog loads async), so
  // without this, reopening an automation shows "Enter Channel ID manually…"
  // with the raw platform id even though the catalog lists the channel by
  // name. Runs once on the first catalog load that contains the initial id,
  // and bails the moment the operator changes the conversation.
  const inboundSelectionReconciledRef = useRef(false);
  const initialInboundGroupId = initialIsTopic
    ? initialConversation?.parentId
    : initialConversation?.recipientUserId
      ? contactSelection(initialConversation.recipientUserId)
      : initialConversation?.conversationId;
  useEffect(() => {
    if (inboundSelectionReconciledRef.current) return;
    if (!initialConversation || !initialInboundGroupId) return;
    if (inboundProvider !== initialConversation.channel) return;
    if (inboundGroupId !== initialInboundGroupId) return;
    const match = telegramGroups.find(
      (group) => group.id === initialInboundGroupId,
    );
    if (!match) return;
    setGroupSelection(match.id);
    inboundSelectionReconciledRef.current = true;
  }, [
    telegramGroups,
    inboundGroupId,
    inboundProvider,
    initialConversation,
    initialInboundGroupId,
  ]);

  // The title snapshot stored on the trigger keeps naming the conversation
  // even when the settings catalog does not list it (or has not loaded yet),
  // as long as the operator has not pointed the trigger elsewhere. It follows
  // the source the fields were loaded from, so a source reopened from the
  // list keeps its name too.
  const originFields = fieldOrigin ? fieldValuesFor(fieldOrigin) : undefined;
  const originIsTopic = originFields?.telegramScope === "topic";
  const fieldsAtOrigin = Boolean(
    fieldOrigin
    && originFields?.groupId
    && inboundProvider === fieldOrigin.channel
    && inboundGroupId.trim() === originFields.groupId,
  );
  const storedGroupTitle = fieldsAtOrigin
    ? (originIsTopic ? fieldOrigin?.parentTitle : fieldOrigin?.title)
    : undefined;
  // A topic's own name, likewise: the topic list loads per group and may not
  // list it by the time the operator saves.
  const storedTopicTitle =
    fieldsAtOrigin
    && originIsTopic
    && telegramScope === "topic"
    && inboundTopicId.trim() === originFields?.topicId
      ? fieldOrigin?.title
      : undefined;
  const destGroups = useMemo(
    () => catalogGroups[destProvider] ?? [],
    [catalogGroups, destProvider],
  );
  const selectedDestGroup = destGroups.find(
    (group) => group.id === destGroupSelection,
  );

  const destSelectionReconciledRef = useRef(false);
  const initialDestGroupId = initialTargetIsTopic
    ? initialTargetSnapshot?.parentId
    : initialTargetSnapshot?.recipientUserId
      ? contactSelection(initialTargetSnapshot.recipientUserId)
      : initialTargetSnapshot?.conversationId;
  useEffect(() => {
    // On edit, preselect the saved destination in the dropdown once it appears
    // in the provider's authorized groups (which can arrive after mount, or when
    // the operator authorizes the group via the in-editor capture flow).
    // Otherwise destGroupSelection stays at MANUAL_GROUP_VALUE, selectedDestGroup
    // is undefined, and the group's friendly title is dropped on re-save. We only
    // mark reconciliation done once we actually match, and bail the moment the
    // user has changed the destination id, so we never override a deliberate
    // manual entry or a provider switch.
    if (destSelectionReconciledRef.current) return;
    if (!initialTargetSnapshot || !initialDestGroupId) return;
    if (destProvider !== initialTargetSnapshot.channel) return;
    if (destGroupId !== initialDestGroupId) return;
    const match = destGroups.find((group) => group.id === initialDestGroupId);
    if (!match) return;
    setDestGroupSelection(match.id);
    destSelectionReconciledRef.current = true;
  }, [
    destGroups,
    destGroupId,
    destProvider,
    initialDestGroupId,
    initialTargetSnapshot,
  ]);

  const [topicOptions, setTopicOptions] = useState<InboundTopicOption[]>([]);
  const [topicSelection, setTopicSelection] = useState<string>(
    initialIsTopic ? MANUAL_GROUP_VALUE : "",
  );
  const selectedTopic = topicOptions.find((topic) => topic.id === topicSelection);

  useEffect(() => {
    const list = props.desktopApi?.listInboundTopics;
    const groupId = inboundGroupId.trim();
    if (
      !list ||
      inboundProvider !== "telegram" ||
      telegramScope !== "topic" ||
      !groupId
    ) {
      setTopicOptions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await list({ provider: "telegram", groupId });
        if (!cancelled) setTopicOptions(result.topics);
      } catch {
        if (!cancelled) setTopicOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.desktopApi, inboundProvider, telegramScope, inboundGroupId]);

  const [captureEntryId, setCaptureEntryId] = useState<string>();
  const [captureMessage, setCaptureMessage] = useState<string>();
  const [captureStatus, setCaptureStatus] = useState<
    "idle" | "waiting" | "captured" | "error"
  >("idle");
  const [captureError, setCaptureError] = useState<string>();
  const [capturedName, setCapturedName] = useState<string>();
  const [capturedGroupTitle, setCapturedGroupTitle] = useState<string>();
  const [captureCopied, setCaptureCopied] = useState(false);
  const canCaptureByCode = Boolean(props.desktopApi?.generateMessagingPairingToken);

  const copyCaptureCode = async (): Promise<void> => {
    if (!captureMessage) return;
    try {
      await copyText(captureMessage, props.desktopApi);
      setCaptureCopied(true);
      window.setTimeout(() => setCaptureCopied(false), 2_000);
    } catch {
      // The code stays selectable as a fallback.
    }
  };

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
    const readMessagingSettings = props.desktopApi?.readMessagingSettings;
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.entry.id !== captureEntryId) return;
      if (!event.entry.observedChat) return;
      const chat = event.entry.observedChat;
      if (chat.kind === "dm") {
        // This code registers a shared conversation. DM triggers instead use
        // authorized contacts, so do not approve a user as a group/workspace.
        void props.desktopApi
          ?.rejectMessagingPairing?.({ entryId: event.entry.id })
          .catch(() => {});
        setCaptureStatus("error");
        setCaptureError(
          "For a DM trigger, choose an authorized contact above. Add new contacts in Settings > Messaging.",
        );
        setCaptureEntryId(undefined);
        return;
      }
      applyObservedChat(chat);
      setCaptureStatus("captured");
      setCaptureMessage(undefined);
      setValidationError(undefined);
      // Authorize the conversation so the trigger can actually fire, then
      // refresh the known-group list so it appears in the picker.
      void (async () => {
        try {
          await approve?.({ entryId: event.entry.id });
          const response = await readMessagingSettings?.();
          if (response) {
            setProviderGroups(readProviderGroups(response.snapshot));
            setDiscordServers(readDiscordServers(response.snapshot));
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

  // The conversation the fields currently describe. It is one source among
  // possibly several: `extraSources` holds the rest.
  const fieldConversation = readInboundConversation({
    groupId: inboundGroupId,
    groupTitle: selectedGroup?.title ?? capturedGroupTitle ?? storedGroupTitle,
    provider: inboundProvider,
    telegramScope,
    topicId: inboundTopicId,
    topicTitle: selectedTopic?.title ?? storedTopicTitle,
  });
  const fieldSource =
    fieldConversation.kind === "complete" ? fieldConversation.conversation : undefined;
  const fieldSourceKey = fieldSource
    ? automationConversationKey(fieldSource)
    : undefined;
  // The list as the operator sees it: every source, with the one open in the
  // fields in its place. A listed source identical to the one in the fields
  // is left out rather than shown twice; it stays in `extraSources`, so
  // pointing the fields elsewhere brings it back instead of dropping it.
  const sourceSlots: Array<
    | { kind: "editing" }
    | { index: number; kind: "listed"; source: AutomationMessagingConversationSnapshot }
  > = [];
  extraSources.forEach((source, index) => {
    if (index === editingIndex) sourceSlots.push({ kind: "editing" });
    if (automationConversationKey(source) !== fieldSourceKey) {
      sourceSlots.push({ index, kind: "listed", source });
    }
  });
  if (editingIndex >= extraSources.length) sourceSlots.push({ kind: "editing" });
  // Every conversation this automation will watch, in list order, without
  // duplicates — picking a channel that is already listed must not watch it
  // twice.
  const inboundSources = dedupeConversations(
    sourceSlots.flatMap((slot) =>
      slot.kind === "listed" ? [slot.source] : fieldSource ? [fieldSource] : [],
    ),
  );
  const multipleSources = inboundSources.length > 1;

  const clearFields = (): void => {
    // The operator has moved off the conversation the picker was being
    // reconciled to; a reconcile still pending from the catalog load would
    // otherwise put it back.
    inboundSelectionReconciledRef.current = true;
    // Back to the fields' defaults, as a fresh form would start.
    setGroupSelection("");
    setInboundGroupId("");
    setInboundManualKind("channel");
    setTelegramScope("group");
    setTopicSelection("");
    setInboundTopicId("");
    setCapturedGroupTitle(undefined);
    setCapturedName(undefined);
    if (captureStatus === "captured") setCaptureStatus("idle");
    setFieldOrigin(undefined);
    setValidationError(undefined);
  };

  const loadIntoFields = (
    conversation: AutomationMessagingConversationSnapshot,
  ): void => {
    const values = fieldValuesFor(conversation);
    // See clearFields: a pending reconcile must not restore the old pick.
    inboundSelectionReconciledRef.current = true;
    setInboundProvider(conversation.channel);
    setInboundGroupId(values.groupId);
    // By name when the catalog lists it, else as a manual ID — the same two
    // states an automation opened for editing starts in.
    setGroupSelection(
      (catalogGroups[conversation.channel] ?? []).some(
        (group) => group.id === values.groupId,
      )
        ? values.groupId
        : MANUAL_GROUP_VALUE,
    );
    setInboundManualKind(values.manualKind);
    setTelegramScope(values.telegramScope);
    setTopicSelection(values.topicId ? MANUAL_GROUP_VALUE : "");
    setInboundTopicId(values.topicId);
    setCapturedGroupTitle(undefined);
    setCapturedName(undefined);
    if (captureStatus === "captured") setCaptureStatus("idle");
    setFieldOrigin(conversation);
    setValidationError(undefined);
  };

  /** Park the fields' source where it stood and open a new, empty entry last. */
  const watchAnotherConversation = (): void => {
    if (!fieldSource) return;
    const parked = [...extraSources];
    parked.splice(editingIndex, 0, fieldSource);
    const listed = dedupeConversations(parked);
    setExtraSources(listed);
    setEditingIndex(listed.length);
    clearFields();
  };

  /** Swap a listed source into the fields, parking the one they held. */
  const openListedSource = (index: number): void => {
    // Parking a half-filled entry would lose what was typed, and so would
    // abandoning it; say what is missing instead.
    if (fieldConversation.kind === "incomplete") {
      setValidationError(fieldConversation.error);
      return;
    }
    const chosen = extraSources[index];
    if (!chosen) return;
    const parked = [...extraSources];
    if (fieldSource) parked.splice(editingIndex, 0, fieldSource);
    const listed = dedupeConversations(parked);
    const position = listed.indexOf(chosen);
    listed.splice(position, 1);
    setExtraSources(listed);
    setEditingIndex(position);
    loadIntoFields(chosen);
  };

  const removeListedSource = (index: number): void => {
    setExtraSources((current) => current.filter((_, entry) => entry !== index));
    if (index < editingIndex) setEditingIndex(editingIndex - 1);
    setValidationError(undefined);
  };

  /**
   * Drop what the fields hold — a source, or a new entry not yet chosen,
   * which is how an add is cancelled — and open its neighbor, so the fields
   * never sit empty while other sources exist.
   */
  const removeEditedSource = (): void => {
    const position = editingIndex > 0 ? editingIndex - 1 : 0;
    const neighbor = extraSources[position];
    if (!neighbor) {
      clearFields();
      setEditingIndex(0);
      return;
    }
    setExtraSources(extraSources.filter((_, entry) => entry !== position));
    setEditingIndex(position);
    loadIntoFields(neighbor);
  };

  const previewSubscriptionId = useId();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewMessages, setPreviewMessages] = useState<InboundPreviewMessage[]>(
    [],
  );
  const canPreview = Boolean(
    props.desktopApi?.startInboundPreview &&
      props.desktopApi?.onInboundPreviewMessage,
  );
  // One preview subscription per source. Keyed by a sorted string so the
  // effect below restarts only when the set of conversations changes — not on
  // every render that rebuilds the (equal) array, and not when "Watch another"
  // merely moves the fields' conversation into the chips.
  const previewScopeKey = inboundSources
    .map((source) => automationConversationKey(source))
    .sort()
    .join("|");
  const previewScopes = useMemo(
    () => inboundSources,
    // inboundSources is rebuilt each render; its identity is previewScopeKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewScopeKey],
  );
  // The sender picker searches one provider's directory, and its "seen in
  // this conversation" group needs one conversation: the first source on the
  // selected provider.
  const senderScopeConversationId = inboundSources.find(
    (source) => source.channel === inboundProvider,
  )?.conversationId;
  // Each source's answer to "can history be read here?", keyed by source.
  // Unknown until the main process answers. Starting at `false` made the panel
  // assert "History is unavailable" for a frame on every provider that has it.
  const [previewHistoryBySource, setPreviewHistoryBySource] = useState<
    Record<string, boolean>
  >({});
  const previewHistoryAnswers = Object.values(previewHistoryBySource);
  const previewHistorySupported = previewHistoryAnswers.some(Boolean)
    ? true
    : previewHistoryAnswers.length === previewScopes.length
      && previewScopes.length > 0
      ? false
      : undefined;
  // The scope refusals are knowable before the preview opens. Stated only
  // when every source shares one, which is always the case for one source.
  const previewScopeNotes = new Set(inboundSources.map(previewScopeHistoryNote));
  const [previewHistoryNote] =
    previewScopeNotes.size === 1 ? previewScopeNotes : [undefined];

  useEffect(() => {
    if (!previewOpen || previewScopes.length === 0) return;
    const start = props.desktopApi?.startInboundPreview;
    const stop = props.desktopApi?.stopInboundPreview;
    const subscribe = props.desktopApi?.onInboundPreviewMessage;
    if (!start || !subscribe) return;
    setPreviewMessages([]);
    setPreviewHistoryBySource({});
    let active = true;
    const subscriptionIds = previewScopes.map(
      (scope) => `${previewSubscriptionId}:${automationConversationKey(scope)}`,
    );
    previewScopes.forEach((scope, index) => {
      const key = automationConversationKey(scope);
      const answer = (supported: boolean) => {
        if (!active) return;
        setPreviewHistoryBySource((current) => ({ ...current, [key]: supported }));
      };
      void start({
        subscriptionId: subscriptionIds[index],
        provider: scope.channel,
        conversationId: scope.conversationId,
        ...(scope.parentId ? { parentId: scope.parentId } : {}),
        recipientUserId: scope.recipientUserId,
        conversationKind: scope.conversationKind,
      }).then((response) => {
        answer(response.historySupported === true);
      }).catch(() => {
        answer(false);
      });
    });
    const unsubscribe = subscribe((message) => {
      const inScope = previewScopes.some((scope) =>
        matchesAutomationConversation(
          scope,
          { ...message, channel: message.provider },
          message.actor.platformUserId,
        ),
      );
      if (!inScope) return;
      setPreviewMessages((current) =>
        current.some((entry) => entry.id === message.id)
          ? current
          : [message, ...current].slice(0, 25),
      );
    });
    return () => {
      active = false;
      unsubscribe?.();
      for (const subscriptionId of subscriptionIds) {
        void stop?.({ subscriptionId });
      }
    };
  }, [
    previewOpen,
    previewScopes,
    previewSubscriptionId,
    props.desktopApi,
  ]);

  // Shares one evaluator with the main-process matcher so the preview can
  // never claim a match the trigger would reject (or vice versa).
  const previewMessageMatches = (message: InboundPreviewMessage): boolean =>
    inboundSources.some((source) => matchesAutomationConversation(
      source,
      { ...message, channel: message.provider },
      message.actor.platformUserId,
      inboundIncludeReplies,
    )) && evaluateAutomationInboundConditions(inboundConditions, {
      text: message.text,
      platformUserId: message.actor.platformUserId,
      ...(message.actor.isBot === undefined ? {} : { isBot: message.actor.isBot }),
    });

  // Senders observed in the live preview stream feed the picker's
  // "seen in this conversation" group with no extra round trip.
  const observedSenders = useMemo(() => {
    const byId = new Map<string, MessagingSenderSuggestion>();
    for (const message of previewMessages) {
      if (byId.has(message.actor.platformUserId)) continue;
      byId.set(message.actor.platformUserId, {
        platformUserId: message.actor.platformUserId,
        ...(message.actor.displayName
          ? { displayName: message.actor.displayName }
          : {}),
        ...(message.actor.isBot ? { isBot: true } : {}),
        source: "conversation",
      });
    }
    return [...byId.values()];
  }, [previewMessages]);

  /**
   * "Use sender" on a previewed message. Folds into an existing `is one of`
   * sender row when there is one, so clicking three messages builds a single
   * "sender is A, B, or C" condition instead of three mutually exclusive rows
   * that could never all be true at once.
   */
  const addSenderCondition = useCallback(
    (actor: InboundPreviewMessage["actor"]) => {
      const label = actor.displayName ?? actor.platformUserId;
      setSenderLabels((current) => ({
        ...current,
        [actor.platformUserId]: label,
      }));
      setInboundConditions((current) => {
        const existing = current.conditions.find(
          (condition) =>
            condition.field === "sender" && condition.operator === "is_one_of",
        );
        if (!existing) {
          return {
            ...current,
            conditions: [
              ...current.conditions,
              {
                id: `condition-${crypto.randomUUID()}`,
                field: "sender",
                operator: "is_one_of",
                values: [actor.platformUserId],
              },
            ],
          };
        }
        if (existing.values.includes(actor.platformUserId)) return current;
        return {
          ...current,
          conditions: current.conditions.map((condition) =>
            condition.id === existing.id
              ? { ...condition, values: [...condition.values, actor.platformUserId] }
              : condition,
          ),
        };
      });
    },
    [],
  );

  // Connector captions. These state what actually survives into the next
  // stage, so the form reads as a pipeline rather than a pile of fields.
  const inboundConversationLabel = multipleSources
    ? formatAutomationConversationList(inboundSources)
    : selectedGroup?.title
      ?? capturedGroupTitle
      ?? storedGroupTitle
      ?? (inboundGroupId.trim()
        || (inboundSources[0]
          // The caption already says "direct message from" for a contact, so
          // it takes the bare name rather than the "(DM)" list label.
          ? inboundSources[0].recipientUserId
            ? inboundSources[0].title ?? inboundSources[0].recipientUserId
            : formatAutomationConversationLabel(inboundSources[0])
          : "this conversation"));

  const inboundFilterSummary =
    inboundConditions.conditions.length === 0
      ? "no filtering — every message continues"
      : `only messages where ${formatAutomationInboundConditionGroup(inboundConditions, {
          resolveLabel: (value, condition) =>
            condition.field === "sender"
              ? senderLabels[value] ?? value
              : condition.field === "sender_type"
                ? value
                : `"${value}"`,
        })}`;

  const inboundThrottleSummary = (() => {
    const seconds = Number(coalesceWindowSeconds);
    const batching =
      Number.isFinite(seconds) && seconds > 0
        ? `batched runs (${seconds}s window)`
        : "one run per message";
    return `${batching} · at most ${maxRunsPerHour === "unlimited" ? "unlimited" : `${maxRunsPerHour}`} per hour`;
  })();

  const searchSenders = useCallback(
    async (query: string) => {
      const search = props.desktopApi?.searchAutomationSenders;
      if (!search || !inboundProvider) {
        return { suggestions: [], directorySupported: false };
      }
      return search({
        provider: inboundProvider,
        query,
        ...(senderScopeConversationId
          ? { conversationId: senderScopeConversationId }
          : {}),
        ...(initialAutomation?.id ? { automationId: initialAutomation.id } : {}),
      });
    },
    [
      props.desktopApi,
      inboundProvider,
      senderScopeConversationId,
      initialAutomation?.id,
    ],
  );

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
        .filter(
          (thread) =>
            !thread.agent && canChangeExistingThreadAgentDesignation(thread),
        )
        .map((thread) => buildAgentOption(thread)),
    [props.threads],
  );
  const hasUnpromotableCodexThreads = useMemo(
    () =>
      (props.threads ?? []).some(
        (thread) =>
          !thread.agent && !canChangeExistingThreadAgentDesignation(thread),
      ),
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

  // Execution settings resolve against the Agent chosen in the Deliver stage.
  // "Inherit" is a symbolic reference applied at run time, so it is valid to
  // store before an Agent exists — but the editor only claims to know the
  // inherited values (and can only list a model catalog) once one is chosen.
  const agentAssignment = useMemo(
    () => readAssignmentFromThreadKey(threadKey),
    [threadKey],
  );
  const agentThreadSummary = useMemo(
    () =>
      agentAssignment
        ? (props.threads ?? []).find(
            (thread) =>
              thread.id === agentAssignment.threadId
              && thread.source === agentAssignment.backend,
          )
        : undefined,
    [agentAssignment, props.threads],
  );
  const effectiveBackendKind = profileBackend || agentAssignment?.backend;
  const effectiveBackend = backendCatalog?.find(
    (backend) => backend.kind === effectiveBackendKind,
  );
  const catalogModels = effectiveBackend?.launchpadOptions?.models ?? [];
  const selectedCatalogModel = catalogModels.find(
    (model) => model.id === profileModel,
  );
  const reasoningChoices =
    selectedCatalogModel?.reasoningEfforts
    ?? effectiveBackend?.launchpadOptions?.reasoningEfforts
    ?? [];
  const backendLabelFor = (kind: AppServerBackendKind | undefined): string =>
    kind
      ? backendCatalog?.find((backend) => backend.kind === kind)?.label ?? kind
      : "";

  const [cwdCopied, setCwdCopied] = useState(false);
  const [allocatingWorkspace, setAllocatingWorkspace] = useState(false);

  const allocateWorkspace = async (): Promise<void> => {
    const allocate = props.desktopApi?.allocateAutomationWorkspace;
    if (!allocate) return;
    setAllocatingWorkspace(true);
    try {
      const result = await allocate();
      setProfileCwd(result.path);
      setValidationError(undefined);
    } catch (caught) {
      setValidationError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setAllocatingWorkspace(false);
    }
  };

  const copyCwd = async (): Promise<void> => {
    if (!profileCwd.trim()) return;
    await copyText(profileCwd.trim());
    setCwdCopied(true);
    setTimeout(() => setCwdCopied(false), 1_500);
  };

  const browseForCwd = async (): Promise<void> => {
    const pick = props.desktopApi?.pickDirectoryFromDisk;
    if (!pick) return;
    try {
      const result = await pick();
      if (!result.canceled) setProfileCwd(result.path);
    } catch {
      // Dialog failures leave the typed path untouched.
    }
  };

  const loadAgentMcpServers = useMemo(() => {
    const list = props.desktopApi?.listThreadMcpServers;
    if (!list || !agentAssignment) return undefined;
    return async () => {
      const response = await list({
        backend: agentAssignment.backend,
        threadId: agentAssignment.threadId,
      });
      return response.servers;
    };
  }, [props.desktopApi, agentAssignment]);
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

  const draftPrompt = async (): Promise<void> => {
    const draft = props.desktopApi?.draftAutomationPrompt;
    if (!draft) return;
    const description = promptDescription.trim();
    if (!description) {
      setPromptDraftError("Describe what you want the automation to do.");
      return;
    }
    setPromptDrafting(true);
    setPromptDraftError(undefined);
    try {
      const result = await draft({ description });
      if (result.status === "generated") {
        setTaskPrompt(result.prompt);
        setPromptDraftOpen(false);
        setPromptDescription("");
        setValidationError(undefined);
      } else if (result.status === "unavailable") {
        setPromptDraftError(
          "Prompt drafting isn't available for your configured agent backend. Write the prompt manually or see the example.",
        );
      } else {
        setPromptDraftError(
          "Couldn't draft a prompt. Try rephrasing your description.",
        );
      }
    } catch (error) {
      setPromptDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setPromptDrafting(false);
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
      conditionGroup: stampConditionLabels(inboundConditions, senderLabels),
      existingTriggers: initialInboundTriggers,
      fieldConversation,
      includeThreadReplies: inboundIncludeReplies,
      provider: inboundProvider,
      replyDestination,
      resultMode,
      schedule: selectedSchedule.ok ? selectedSchedule.schedule : undefined,
      sources: inboundSources,
      target: buildDestinationSnapshot({
        groupId: destGroupId,
        groupTitle: selectedDestGroup?.title,
        provider: destProvider,
        topicId: destTopicId,
      }),
      triggerKind,
    });
    if (!triggerConfig.ok) {
      setValidationError(triggerConfig.error);
      return;
    }
    const executionProfile = buildExecutionProfile({
      backend: profileBackend,
      cwd: profileCwd,
      executionMode: profileExecutionMode,
      mcpAllowlist: profileMcpAllowlist,
      model: profileModel,
      reasoningEffort: profileReasoning,
      toolAllowlist: profileToolAllowlist,
    });
    const priorRunLookback = lookbackEnabled
      ? {
          maxRuns: Number(lookbackRuns),
          ...(lookbackAgeMs ? { maxAgeMs: Number(lookbackAgeMs) } : {}),
        }
      : undefined;

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
          priorRunLookback: priorRunLookback ?? null,
          ...(triggerKind === "inbound_message"
            ? {
                inboundCoalesceWindowMs: parseCoalesceWindowMs(
                  coalesceWindowSeconds,
                ),
                maxRunsPerHour: parseMaxRunsPerHour(maxRunsPerHour),
              }
            : {}),
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
        ...(priorRunLookback ? { priorRunLookback } : {}),
        ...(triggerKind === "inbound_message"
          ? {
              inboundCoalesceWindowMs: parseCoalesceWindowMs(
                coalesceWindowSeconds,
              ),
              maxRunsPerHour: parseMaxRunsPerHour(maxRunsPerHour),
            }
          : {}),
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
      <label className="automation-field automation-field--wide">
        <span>Name</span>
        <input
          value={name}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setValidationError(undefined);
          }}
        />
      </label>

      <div className="automation-funnel">
        <AutomationStage verb="When" title="Trigger">
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
          {triggerKind === "schedule" ? (
            <>
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
                    <label className="automation-field automation-field--narrow">
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
                    <label className="automation-field automation-field--compact">
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
                    <label className="automation-field automation-field--narrow">
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
            </>
          ) : (
            <>
                  {noProvidersEnabled ? (
                    <p className="automation-editor__error" role="alert">
                      No messaging providers are enabled. Enable one in Settings &gt;
                      Messaging before creating an inbound trigger.
                    </p>
                  ) : null}
                  {sourceSlots.length > 1 ? (
                    <div className="automation-sources__watching">
                      <span
                        className="automation-sources__label"
                        id={watchingLabelId}
                      >
                        Watching
                      </span>
                      {/* The sender picker's chip markup, so a removable list
                          reads the same everywhere in this editor. The chip
                          open in the fields below is marked; any other opens
                          there when picked. */}
                      <ul
                        aria-labelledby={watchingLabelId}
                        className="automation-sender-picker__chips"
                      >
                        {sourceSlots.map((slot) => {
                          if (slot.kind === "editing") {
                            const label = fieldSource
                              ? formatInboundSourceLabel(fieldSource, {
                                  withProvider: false,
                                })
                              : fieldConversation.kind === "empty"
                                ? "New conversation"
                                : "Unfinished conversation";
                            return (
                              <li
                                aria-current="true"
                                className="chip automation-sender-chip automation-source-chip is-editing"
                                key="editing"
                              >
                                <span className="automation-source-chip__label">
                                  {label}
                                </span>
                                <button
                                  aria-label={
                                    fieldSource
                                      ? `Stop watching ${label}`
                                      : "Discard this conversation"
                                  }
                                  className="automation-sender-chip__remove"
                                  type="button"
                                  onClick={removeEditedSource}
                                >
                                  ×
                                </button>
                              </li>
                            );
                          }
                          // The provider is named only where it differs from
                          // the one selected below.
                          const label = formatInboundSourceLabel(slot.source, {
                            withProvider: slot.source.channel !== inboundProvider,
                          });
                          return (
                            <li
                              className="chip automation-sender-chip automation-source-chip"
                              key={automationConversationKey(slot.source)}
                            >
                              <button
                                aria-label={`Edit ${label}`}
                                className="automation-source-chip__open"
                                title="Edit this conversation"
                                type="button"
                                onClick={() => openListedSource(slot.index)}
                              >
                                {label}
                              </button>
                              <button
                                aria-label={`Stop watching ${label}`}
                                className="automation-sender-chip__remove"
                                type="button"
                                onClick={() => removeListedSource(slot.index)}
                              >
                                ×
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
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
                          setTopicSelection("");
                          setInboundTopicId("");
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
                    {telegramGroups.length > 0 ? (
                      <div className="automation-field automation-field--picker">
                        {/* Not the provider's noun: this list holds DMs as well
                            as rooms, and the picker composes its accessible
                            name from this label — "Channel: Dana Okonkwo" was
                            false for every DM row. */}
                        <span>Conversation</span>
                        <MessagingSurfacePicker
                          key={`inbound:${inboundProvider}`}
                          fieldLabel="Conversation"
                          filterConversations
                          options={conversationOptions(telegramGroups)}
                          value={pickerValue(groupSelection)}
                          {...conversationPickerLabels(inboundProvider, "trigger")}
                          onChange={(picked) => {
                            const value = selectionValue(picked);
                            setGroupSelection(value);
                            setInboundGroupId(value === MANUAL_GROUP_VALUE ? "" : value);
                            setTopicSelection("");
                            setInboundTopicId("");
                            setValidationError(undefined);
                          }}
                        />
                      </div>
                    ) : null}
                  </div>

                  {inboundProvider === "discord" ? (
                    <DiscordChannelHint
                      canList={Boolean(props.desktopApi?.listDiscordThreadPermissionChannels)}
                      catalog={discordCatalog}
                      servers={discordServers}
                    />
                  ) : null}
                  {inboundGroupId.trim()
                  && !isContactSelection(inboundGroupId)
                  && groupDeliveryHint(inboundProvider) ? (
                    <p className="automation-field__hint">
                      {groupDeliveryHint(inboundProvider)}
                    </p>
                  ) : null}

                  {telegramGroups.length === 0 ||
                  groupSelection === MANUAL_GROUP_VALUE ? (
                    <div className="automation-field-group">
                      <div
                        aria-label="Surface kind"
                        className="automation-segmented"
                        role="group"
                      >
                        {([
                          ["channel", conversationPickerLabel(inboundProvider)],
                          ["dm", "Direct message"],
                        ] as const).map(([kind, label]) => (
                          <button
                            key={kind}
                            aria-pressed={inboundManualKind === kind}
                            className={`automation-segmented__button${
                              inboundManualKind === kind ? " is-active" : ""
                            }`}
                            type="button"
                            onClick={() => {
                              setInboundManualKind(kind);
                              setInboundGroupId(
                                encodeManualSurface(kind, inboundGroupId),
                              );
                              setValidationError(undefined);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <label className="automation-field">
                        <span>
                          {inboundManualKind === "dm"
                            ? recipientLabel(inboundProvider)
                            : conversationLabel(inboundProvider)}
                        </span>
                        <input
                          placeholder={
                            inboundManualKind === "dm"
                              ? recipientPlaceholder(inboundProvider)
                              : conversationPlaceholder(inboundProvider)
                          }
                          value={manualSurfaceValue(inboundGroupId)}
                          onChange={(event) => {
                            setInboundGroupId(
                              encodeManualSurface(
                                inboundManualKind,
                                event.currentTarget.value,
                              ),
                            );
                            setValidationError(undefined);
                          }}
                        />
                      </label>
                      <p className="automation-field__hint">
                        {inboundManualKind === "dm"
                          ? recipientHint(inboundProvider)
                          : conversationHint(inboundProvider)}
                      </p>
                    </div>
                  ) : null}

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
                              : conversationPickerLabel(inboundProvider).toLowerCase()}{" "}
                            you want to watch. PwrAgent will detect it and fill in the
                            details.
                          </p>
                          {captureMessage ? (
                            <div className="automation-capture__code-row">
                              <pre className="automation-capture__code">
                                {captureMessage}
                              </pre>
                              <button
                                className="button button--ghost automation-capture__copy"
                                type="button"
                                onClick={() => void copyCaptureCode()}
                              >
                                {captureCopied ? "Copied" : "Copy"}
                              </button>
                            </div>
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

                  {inboundProvider === "telegram" && !isContactSelection(inboundGroupId) ? (
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
                          {topicOptions.length > 0 ? (
                            <div className="automation-field automation-field--picker">
                              <span>Topic</span>
                              <MessagingSurfacePicker
                                fieldLabel="Topic"
                                filterConversations={false}
                                options={conversationOptions(topicOptions)}
                                value={pickerValue(topicSelection)}
                                placeholder="Choose a topic"
                                searchPlaceholder="Find a topic or ID"
                                manualLabel="Enter topic ID manually..."
                                sectionLabels={{ other: "Topics" }}
                                emptyLabel="No matching topics."
                                onChange={(picked) => {
                                  const value = selectionValue(picked);
                                  setTopicSelection(value);
                                  setInboundTopicId(
                                    value === MANUAL_GROUP_VALUE ? "" : value,
                                  );
                                  setValidationError(undefined);
                                }}
                              />
                            </div>
                          ) : null}
                          {topicOptions.length === 0 ||
                          topicSelection === MANUAL_GROUP_VALUE ? (
                            <>
                              <label className="automation-field">
                                <span>Topic ID</span>
                                <input
                                  placeholder="e.g. 42"
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
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {fieldSource || multipleSources ? (
                    <div className="automation-field-group automation-sources">
                      {fieldSource ? (
                        <button
                          className="button button--ghost automation-sources__add"
                          type="button"
                          onClick={watchAnotherConversation}
                        >
                          {/* "Conversation", like the picker above: it offers
                              DMs beside channels and groups. */}
                          Watch another conversation
                        </button>
                      ) : null}
                      {multipleSources ? (
                        <p className="automation-field__hint">
                          A message in any of these can start a run. They share
                          the filters, batching window, and hourly cap below.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
            </>
          )}
        </AutomationStage>

        <AutomationFlow
          caption={
            triggerKind === "schedule"
              ? `fires ${selectedScheduleSummary} — no filtering or batching needed`
              : inboundSources.length === 1 && inboundSources[0]?.recipientUserId
                // A contact trigger matches on the sender, not the room.
                ? `every direct message from ${inboundConversationLabel}`
                : `every message in ${inboundConversationLabel}`
          }
        />

        {triggerKind === "inbound_message" ? (
          <>
            <AutomationStage verb="Only if" title="Filters">
                  <AutomationConditionEditor
                    group={inboundConditions}
                    conversationId={senderScopeConversationId}
                    observedSenders={observedSenders}
                    provider={inboundProvider}
                    searchSenders={searchSenders}
                    senderLabels={senderLabels}
                    {...(initialAutomation?.id ? { automationId: initialAutomation.id } : {})}
                    onChange={(group) => {
                      setInboundConditions(group);
                      setValidationError(undefined);
                    }}
                    onSenderLabelsChange={setSenderLabels}
                  />

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
                  {canPreview ? (
                    <div className="automation-preview">
                      <button
                        className="button button--ghost automation-preview__toggle"
                        disabled={inboundSources.length === 0}
                        type="button"
                        onClick={() => setPreviewOpen((open) => !open)}
                      >
                        {previewOpen ? "Stop preview" : "Preview live messages"}
                      </button>
                      {inboundSources.length === 0 ? (
                        <p className="automation-field__hint">
                          Enter a conversation above to preview its incoming messages.
                        </p>
                      ) : !previewOpen && previewHistoryNote ? (
                        <p className="automation-field__hint">
                          {previewHistoryNote}
                        </p>
                      ) : null}
                      {previewOpen && inboundSources.length > 0 ? (
                        <div className="automation-preview__panel" role="status">
                          <p className="automation-field__hint">
                            {previewHistorySupported === undefined
                              ? "Messages your filter would match are highlighted."
                              : previewHistorySupported
                                ? "Showing available recent history, then messages as they arrive. Messages your filter would match are highlighted."
                                : "Showing messages as they arrive; no history is available for this conversation. Messages your filter would match are highlighted."}
                          </p>
                          {previewMessages.length === 0 ? (
                            <p className="automation-preview__empty">
                              Waiting for messages...
                            </p>
                          ) : (
                            <ul className="automation-preview__list">
                              {previewMessages.map((message) => {
                                const matched = previewMessageMatches(message);
                                return (
                                  <li
                                    key={message.id}
                                    className={`automation-preview__item${
                                      matched ? " is-match" : ""
                                    }`}
                                  >
                                    <span className="automation-preview__sender">
                                      <span className="automation-preview__sender-name">
                                        {message.actor.displayName ??
                                          message.actor.platformUserId}
                                        {message.actor.isBot ? " (bot)" : ""}
                                      </span>
                                      {message.actor.displayName ? (
                                        <span className="automation-preview__sender-id">
                                          {message.actor.platformUserId}
                                        </span>
                                      ) : null}
                                      {multipleSources ? (
                                        <span className="automation-preview__source">
                                          in {formatPreviewSourceLabel(
                                            message,
                                            inboundSources,
                                          )}
                                        </span>
                                      ) : null}
                                      <span className="automation-preview__time">
                                        {message.origin === "history"
                                          ? `history · ${formatAutomationRelative(
                                              message.receivedAt,
                                            )}`
                                          : formatAutomationRelative(message.receivedAt)}
                                      </span>
                                    </span>
                                    <span className="automation-preview__text">
                                      {message.text || "(no text)"}
                                    </span>
                                    <span className="automation-preview__row-actions">
                                      {matched ? (
                                        <span className="automation-preview__badge">
                                          matches
                                        </span>
                                      ) : null}
                                      <button
                                        className="automation-preview__use-sender"
                                        title="Filter to this sender"
                                        type="button"
                                        onClick={() => {
                                          addSenderCondition(message.actor);
                                          setValidationError(undefined);
                                        }}
                                      >
                                        Use sender
                                      </button>
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
            </AutomationStage>

            <AutomationFlow caption={inboundFilterSummary} />

            <AutomationStage verb="Group" title="Coalescing & rate limit">
                  <div className="automation-field-group">
                    <label className="automation-field automation-field--narrow">
                      <span>Coalesce window (seconds)</span>
                      <input
                        min={0}
                        type="number"
                        value={coalesceWindowSeconds}
                        onChange={(event) => {
                          setCoalesceWindowSeconds(event.currentTarget.value);
                          setValidationError(undefined);
                        }}
                      />
                    </label>
                    <p className="automation-field__hint">
                      The first matching message runs immediately; more messages within
                      this window are batched into a single run. Protects against bursts
                      and loops. Set to 0 to run once per message.
                    </p>
                  </div>

                  <div className="automation-field-group">
                    <label className="automation-field automation-field--compact">
                      <span>Max runs per hour</span>
                      <select
                        value={maxRunsPerHour}
                        onChange={(event) => {
                          setMaxRunsPerHour(event.currentTarget.value);
                          setValidationError(undefined);
                        }}
                      >
                        {runRateOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}/hr
                          </option>
                        ))}
                        <option value="unlimited">Unlimited</option>
                      </select>
                    </label>
                    <p className="automation-field__hint">
                      Hard cap on how many inbound-triggered runs this automation starts
                      each hour, even if coalescing is off. A safety backstop against
                      runaway agent runs (and token spend) from a busy channel or a
                      message loop. Over-limit messages are dropped.
                    </p>
                  </div>
            </AutomationStage>

            <AutomationFlow caption={inboundThrottleSummary} />
          </>
        ) : null}

        <AutomationStage verb="Then run" title="AI evaluation">
          <p className="automation-field__hint">
            Each run is an ephemeral sub-agent: it starts from this prompt every
            time, has no memory of earlier runs unless you give it lookback
            below, and can&rsquo;t be chatted with afterward. Its output lands in
            the Agent&rsquo;s queryable context, where you — or the Agent — can
            dig further and take corrective action.
          </p>
          <div className="automation-field automation-prompt-field">
            <div className="automation-prompt-field__label-row">
              <span id={promptLabelId}>Task prompt</span>
              <div className="automation-prompt-field__tools">
                <button
                  aria-controls={promptHelpId}
                  aria-expanded={promptHelpOpen}
                  aria-label="Prompt examples"
                  className="automation-agent-help"
                  type="button"
                  onClick={() => setPromptHelpOpen((open) => !open)}
                >
                  <HelpCircleIcon size={14} aria-hidden="true" />
                </button>
                {canDraftPrompt ? (
                  <button
                    className="automation-prompt-field__draft-toggle"
                    type="button"
                    onClick={() => {
                      setPromptDraftOpen((open) => !open);
                      setPromptDraftError(undefined);
                    }}
                  >
                    Help me write a prompt
                  </button>
                ) : null}
              </div>
            </div>
            {promptHelpOpen ? (
              <div className="automation-agent-help-popover" id={promptHelpId} role="note">
                Write what the agent should do each time it runs, addressed to the
                agent. For example: "Investigate the Datadog alert in the incoming
                message. Check recent error rates and deploys, then post a 3-bullet
                summary of the likely cause and whether it is still firing."
              </div>
            ) : null}
            {promptDraftOpen ? (
              <div className="automation-prompt-draft">
                <textarea
                  aria-label="Describe what you want the automation to do"
                  className="automation-prompt-draft__input"
                  placeholder="e.g. tell me what's wrong when Datadog alerts, and whether we've seen it before"
                  rows={2}
                  value={promptDescription}
                  onChange={(event) => {
                    setPromptDescription(event.currentTarget.value);
                    setPromptDraftError(undefined);
                  }}
                />
                <div className="automation-prompt-draft__actions">
                  <button
                    className="button button--primary"
                    disabled={promptDrafting}
                    type="button"
                    onClick={() => void draftPrompt()}
                  >
                    {promptDrafting ? "Drafting..." : "Draft prompt"}
                  </button>
                  <button
                    className="button button--ghost"
                    type="button"
                    onClick={() => {
                      setPromptDraftOpen(false);
                      setPromptDraftError(undefined);
                    }}
                  >
                    Cancel
                  </button>
                </div>
                {promptDraftError ? (
                  <p className="automation-editor__error" role="alert">
                    {promptDraftError}
                  </p>
                ) : null}
              </div>
            ) : null}
            <textarea
              aria-labelledby={promptLabelId}
              placeholder="Investigate the alert in the incoming message and post a short summary of the likely cause."
              rows={5}
              value={taskPrompt}
              onChange={(event) => {
                setTaskPrompt(event.currentTarget.value);
                setValidationError(undefined);
              }}
            />
          </div>
          <label className="automation-checkbox">
            <input
              checked={lookbackEnabled}
              type="checkbox"
              onChange={(event) => setLookbackEnabled(event.currentTarget.checked)}
            />
            <span>Show this run the outcomes of its own recent runs</span>
          </label>
          {lookbackEnabled ? (
            <div className="automation-inline-fields">
              <label className="automation-field automation-field--compact">
                <span>Include up to</span>
                <select
                  value={lookbackRuns}
                  onChange={(event) => setLookbackRuns(event.currentTarget.value)}
                >
                  {["1", "3", "5", "10", "20"].map((count) => (
                    <option key={count} value={count}>
                      {count === "1" ? "1 run" : `${count} runs`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="automation-field automation-field--compact">
                <span>No older than</span>
                <select
                  value={lookbackAgeMs}
                  onChange={(event) => setLookbackAgeMs(event.currentTarget.value)}
                >
                  <option value={String(15 * 60 * 1000)}>15 minutes</option>
                  <option value={String(60 * 60 * 1000)}>1 hour</option>
                  <option value={String(6 * 60 * 60 * 1000)}>6 hours</option>
                  <option value={String(24 * 60 * 60 * 1000)}>24 hours</option>
                  <option value="">Any age</option>
                </select>
              </label>
            </div>
          ) : null}
          {lookbackEnabled ? (
            <p className="automation-field__hint">
              Prior outcomes are added to the prompt so it can judge whether an
              event is new, recurring, or escalating — ask for that explicitly,
              e.g. &ldquo;if this has happened before in the lookback, say how
              often and raise the urgency.&rdquo;
            </p>
          ) : null}

          <details className="automation-advanced">
            <summary className="automation-advanced__summary">
              Advanced settings — model, access, tools, gate, backlog
            </summary>
            <p className="automation-advanced__hint">
              Optional. Leave these alone to inherit the Agent's settings.
            </p>
          <div className="automation-fieldset">
            <p className="automation-fieldset__legend">Execution</p>
            <div className="automation-field-group">
              <label className="automation-field">
                <span>Working directory</span>
                <div className="automation-cwd-row">
                  <input
                    value={profileCwd}
                    placeholder="Inherit the Agent's directory"
                    onChange={(event) => setProfileCwd(event.currentTarget.value)}
                  />
                  {profileCwd.trim() ? (
                    <button
                      className="button button--ghost"
                      type="button"
                      onClick={() => void copyCwd()}
                    >
                      {cwdCopied ? "Copied" : "Copy"}
                    </button>
                  ) : null}
                </div>
              </label>
              <div className="automation-cwd-actions">
                {props.directories ? (
                  <ProjectPicker
                    directories={props.directories}
                    value={props.directories.find(
                      (directory) =>
                        directory.path !== undefined
                        && directory.path === profileCwd.trim(),
                    )}
                    onSelect={(directory) => {
                      if (directory.path) setProfileCwd(directory.path);
                      setValidationError(undefined);
                    }}
                    onPickFromDisk={() => void browseForCwd()}
                  />
                ) : (
                  <button
                    className="button button--ghost"
                    type="button"
                    onClick={() => void browseForCwd()}
                  >
                    Browse…
                  </button>
                )}
                {props.desktopApi?.allocateAutomationWorkspace ? (
                  <button
                    className="button button--ghost"
                    disabled={allocatingWorkspace}
                    type="button"
                    onClick={() => void allocateWorkspace()}
                  >
                    {allocatingWorkspace
                      ? "Allocating…"
                      : "Allocate Workspace sandbox"}
                  </button>
                ) : null}
              </div>
              <p className="automation-field__hint">
                Runs execute here. Pick a project, or allocate a fresh sandbox
                under this profile&rsquo;s Workspaces directory when the
                automation shouldn&rsquo;t touch a repo.
              </p>
            </div>
            <div className="automation-field">
              <span>Run settings</span>
              <div className="automation-execution-chips">
                <ComposerDropdown
                  ariaLabel="Automation access"
                  options={[
                    { label: "Inherit Agent access", value: "" },
                    ...ACCESS_MODE_OPTIONS,
                  ]}
                  value={profileExecutionMode}
                  onChange={(value) =>
                    setProfileExecutionMode(value as OptionalExecutionMode)
                  }
                />
                <ComposerDropdown
                  ariaLabel="Automation model provider"
                  options={[
                    {
                      label: agentAssignment
                        ? `Inherit Agent provider (${backendLabelFor(agentAssignment.backend)})`
                        : "Inherit Agent provider",
                      value: "",
                    },
                    ...(backendCatalog ?? [])
                      .filter(
                        (backend) =>
                          backend.available || backend.kind === profileBackend,
                      )
                      .map((backend) => ({
                        label: backend.label,
                        value: backend.kind,
                      })),
                  ]}
                  value={profileBackend}
                  onChange={(value) => {
                    const next = value as "" | AppServerBackendKind;
                    setProfileBackend(next);
                    // A model belongs to one provider's catalog. Keep the
                    // selection only when the new catalog still lists it.
                    const nextKind = next || agentAssignment?.backend;
                    const nextModels =
                      backendCatalog?.find((backend) => backend.kind === nextKind)
                        ?.launchpadOptions?.models ?? [];
                    if (
                      profileModel
                      && !nextModels.some((model) => model.id === profileModel)
                    ) {
                      setProfileModel("");
                      setProfileReasoning("");
                    }
                  }}
                />
                <ComposerDropdown
                  ariaLabel="Automation model"
                  disabled={!effectiveBackendKind}
                  options={[
                    {
                      label: agentThreadSummary?.model
                        ? `Inherit Agent model (${agentThreadSummary.model})`
                        : "Inherit Agent model",
                      value: "",
                    },
                    ...(profileModel
                    && !catalogModels.some((model) => model.id === profileModel)
                      ? [
                          {
                            label: `${profileModel} (not in this provider's catalog)`,
                            value: profileModel,
                          },
                        ]
                      : []),
                    ...catalogModels.map((model) => ({
                      label: model.label ?? model.id,
                      value: model.id,
                    })),
                  ]}
                  value={profileModel}
                  onChange={(value) => {
                    setProfileModel(value);
                    // Reasoning choices are per-model; drop a value the new
                    // model does not offer rather than sending it anyway.
                    const nextModel = catalogModels.find(
                      (model) => model.id === value,
                    );
                    const efforts =
                      nextModel?.reasoningEfforts
                      ?? effectiveBackend?.launchpadOptions?.reasoningEfforts
                      ?? [];
                    if (profileReasoning && !efforts.includes(profileReasoning)) {
                      setProfileReasoning("");
                    }
                  }}
                />
                <ComposerDropdown
                  ariaLabel="Automation reasoning"
                  disabled={!effectiveBackendKind}
                  options={[
                    {
                      label: agentThreadSummary?.reasoningEffort
                        ? `Inherit Agent reasoning (${agentThreadSummary.reasoningEffort})`
                        : "Inherit Agent reasoning",
                      value: "",
                    },
                    ...(profileReasoning && !reasoningChoices.includes(profileReasoning)
                      ? [{ label: profileReasoning, value: profileReasoning }]
                      : []),
                    ...reasoningChoices.map((reasoning) => ({
                      label: reasoning,
                      value: reasoning,
                    })),
                  ]}
                  value={profileReasoning}
                  onChange={(value) => setProfileReasoning(value)}
                />
              </div>
            </div>
            {!effectiveBackendKind ? (
              <p className="automation-field__hint">
                Model choices come from the provider&rsquo;s catalog. Choose an
                Agent in Deliver below, or pick a provider here, to list them.
              </p>
            ) : null}
            <div className="automation-field-group">
              <div className="automation-field">
                <span>Allowed MCP servers</span>
                <AutomationMcpPicker
                  loadServers={loadAgentMcpServers}
                  selected={profileMcpAllowlist}
                  onChange={setProfileMcpAllowlist}
                />
              </div>
              <p className="automation-field__hint">
                MCP servers this run may use to fetch data, picked from the
                Agent&rsquo;s configured servers. Leave empty to inherit all of
                the Agent&rsquo;s MCP servers.
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
                Restrict which individual tools the run may call. Leave blank to
                allow every tool from the servers above plus the Agent&rsquo;s
                built-ins.
              </p>
            </div>
          </div>

          <div className="automation-fieldset">
            <p className="automation-fieldset__legend">Gate</p>
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
          </div>

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
          </details>
        </AutomationStage>

        <AutomationFlow caption="each run&rsquo;s analysis" />

        <AutomationStage verb="Deliver" title="Where results go">
          <div className="automation-lanes">
            <div className="automation-lane automation-lane--active">
              <span className="automation-lane__tag">Agent thread · always</span>
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
                                {threadOptions.length === 0 && hasUnpromotableCodexThreads
                                  ? CODEX_AGENT_THREAD_CREATION_NOTE
                                  : "No regular threads match."}
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
              <p className="automation-field__hint">
                Every run&rsquo;s analysis lands in this Agent&rsquo;s context, so you can
                ask it about patterns across runs.
              </p>
            </div>
            {triggerKind === "inbound_message" ? (
              <div
                className={
                  resultMode === "agent_only"
                    ? "automation-lane"
                    : "automation-lane automation-lane--active"
                }
              >
                <span className="automation-lane__tag">Messaging · optional</span>
                      <div className="automation-field-group">
                        <label className="automation-field">
                          <span>Where should the result go?</span>
                          <select
                            value={resultMode}
                            onChange={(event) => {
                              setResultMode(event.currentTarget.value as ResultMode);
                              setValidationError(undefined);
                            }}
                          >
                            <option value="reply_source">
                              Reply where the message came from
                            </option>
                            <option value="different">Send to a different conversation</option>
                            <option value="agent_only">Only the Agent (no message back)</option>
                          </select>
                        </label>
                        <p className="automation-field__hint">
                          The Agent thread always gets the analysis as context. This controls
                          whether PwrAgent also posts the result somewhere people will see it.
                        </p>
                      </div>

                      {resultMode === "reply_source" ? (
                        <>
                          <label className="automation-field">
                            <span>Reply location</span>
                            <select
                              value={replyDestination}
                              onChange={(event) => {
                                setReplyDestination(
                                  event.currentTarget.value as AutomationSourceMessageDestination,
                                );
                                setValidationError(undefined);
                              }}
                            >
                              <option value="source_thread">
                                {replyThreadLabel(inboundProvider)}
                              </option>
                              <option value="source_channel">
                                {replyChannelLabel(inboundProvider)}
                              </option>
                            </select>
                          </label>
                          {inboundProvider === "slack" ? (
                            <label className="automation-checkbox">
                              <input
                                checked={sourceReplyBroadcast}
                                type="checkbox"
                                onChange={(event) =>
                                  setSourceReplyBroadcast(event.currentTarget.checked)
                                }
                              />
                              <span>Also broadcast the reply to the channel</span>
                            </label>
                          ) : null}
                        </>
                      ) : null}

                      {resultMode === "different" ? (
                        <div className="automation-field-group">
                          <div className="automation-inline-fields">
                            <label className="automation-field">
                              <span>Destination provider</span>
                              <select
                                value={destProvider}
                                onChange={(event) => {
                                  setDestProvider(
                                    event.currentTarget.value as MessagingChannelKind,
                                  );
                                  setDestGroupSelection("");
                                  setDestGroupId("");
                                  setDestTopicId("");
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
                            {destGroups.length > 0 ? (
                              <div className="automation-field automation-field--picker">
                                <span>Destination</span>
                                <MessagingSurfacePicker
                                  key={`dest:${destProvider}`}
                                  fieldLabel="Destination"
                                  filterConversations
                                  options={conversationOptions(destGroups)}
                                  value={pickerValue(destGroupSelection)}
                                  {...conversationPickerLabels(destProvider, "destination")}
                                  onChange={(picked) => {
                                    const value = selectionValue(picked);
                                    setDestGroupSelection(value);
                                    setDestGroupId(value === MANUAL_GROUP_VALUE ? "" : value);
                                    setValidationError(undefined);
                                  }}
                                />
                              </div>
                            ) : null}
                          </div>
                          {destGroups.length === 0 ||
                          destGroupSelection === MANUAL_GROUP_VALUE ? (
                            <>
                              <div
                                aria-label="Destination surface kind"
                                className="automation-segmented"
                                role="group"
                              >
                                {([
                                  ["channel", conversationPickerLabel(destProvider)],
                                  ["dm", "Direct message"],
                                ] as const).map(([kind, label]) => (
                                  <button
                                    key={kind}
                                    aria-pressed={destManualKind === kind}
                                    className={`automation-segmented__button${
                                      destManualKind === kind ? " is-active" : ""
                                    }`}
                                    type="button"
                                    onClick={() => {
                                      setDestManualKind(kind);
                                      setDestGroupId(
                                        encodeManualSurface(kind, destGroupId),
                                      );
                                      setValidationError(undefined);
                                    }}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                              <label className="automation-field">
                                <span>
                                  Destination{" "}
                                  {lowerLead(
                                    destManualKind === "dm"
                                      ? recipientLabel(destProvider)
                                      : conversationLabel(destProvider),
                                  )}
                                </span>
                                <input
                                  placeholder={
                                    destManualKind === "dm"
                                      ? recipientPlaceholder(destProvider)
                                      : conversationPlaceholder(destProvider)
                                  }
                                  value={manualSurfaceValue(destGroupId)}
                                  onChange={(event) => {
                                    setDestGroupId(
                                      encodeManualSurface(
                                        destManualKind,
                                        event.currentTarget.value,
                                      ),
                                    );
                                    setValidationError(undefined);
                                  }}
                                />
                              </label>
                            </>
                          ) : null}
                          {/* Same test the trigger side applies to its own
                              topic controls. A 1:1 DM has no forum topics, and
                              `buildDestinationSnapshot` returns before it ever
                              reads `destTopicId` for a contact — so leaving the
                              field up lets the operator fill in a value that
                              Save discards without a word. */}
                          {destProvider === "telegram"
                          && !isContactSelection(destGroupId) ? (
                            <label className="automation-field">
                              <span>Destination topic ID (optional)</span>
                              <input
                                placeholder="e.g. 42"
                                value={destTopicId}
                                onChange={(event) => {
                                  setDestTopicId(event.currentTarget.value);
                                  setValidationError(undefined);
                                }}
                              />
                            </label>
                          ) : null}
                          {destProvider === "discord" ? (
                            <DiscordChannelHint
                              canList={Boolean(props.desktopApi?.listDiscordThreadPermissionChannels)}
                              catalog={discordCatalog}
                              servers={discordServers}
                            />
                          ) : null}
                          <p className="automation-field__hint">
                            {contactUserId(destGroupId)
                              ? `The result is sent to ${
                                  selectedDestGroup?.title ?? contactUserId(destGroupId)
                                } as a direct message, instead of back where the trigger fired.`
                              : "The result is posted here instead of back where the trigger fired."}
                          </p>
                        </div>
                      ) : null}
              </div>
            ) : null}
          </div>
        </AutomationStage>
      </div>

      <label className="automation-checkbox">
        <input
          checked={enabled}
          type="checkbox"
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />
        <span>Enabled</span>
      </label>

      {validationError ? (
        <p className="automation-editor__error" ref={errorRef} role="alert">
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
  backend: "" | AppServerBackendKind;
  cwd: string;
  executionMode: OptionalExecutionMode;
  mcpAllowlist: string[];
  model: string;
  reasoningEffort: string;
  toolAllowlist: string;
}): CreateAutomationRequest["executionProfile"] {
  const cwd = params.cwd.trim();
  const model = params.model.trim();
  const reasoningEffort = params.reasoningEffort.trim();
  const mcpAllowlist = params.mcpAllowlist
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const toolAllowlist = parseAllowlist(params.toolAllowlist);
  if (
    !params.backend &&
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
    ...(params.backend ? { backend: params.backend } : {}),
    ...(cwd ? { cwd } : {}),
    ...(params.executionMode ? { executionMode: params.executionMode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(mcpAllowlist.length > 0 ? { mcpAllowlist } : {}),
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
  };
}

function parseCoalesceWindowMs(value: string): number | undefined {
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.floor(seconds) * 1000;
}

function parseMaxRunsPerHour(value: string): number | null {
  if (value === "unlimited") return null;
  const rate = Number(value.trim());
  return Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : null;
}

function parseAllowlist(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Persist the display names the picker resolved onto the conditions
 * themselves. Without this the labels die with the editor session, and every
 * later surface — reopening the editor, the list screen's trigger summary —
 * falls back to raw platform ids.
 */
function stampConditionLabels(
  group: AutomationInboundConditionGroup,
  senderLabels: Record<string, string>,
): AutomationInboundConditionGroup {
  return {
    ...group,
    conditions: group.conditions.map((condition) => {
      if (condition.field !== "sender") return condition;
      const valueLabels: Record<string, string> = {};
      for (const value of condition.values) {
        const label = senderLabels[value] ?? condition.valueLabels?.[value];
        if (label && label !== value) valueLabels[value] = label;
      }
      return Object.keys(valueLabels).length > 0
        ? { ...condition, valueLabels }
        : condition;
    }),
  };
}

function buildTriggerConfig(params: {
  broadcast: boolean;
  conditionGroup: AutomationInboundConditionGroup;
  /** The automation's stored inbound triggers, whose ids a re-save keeps. */
  existingTriggers: readonly AutomationInboundMessageTriggerDefinition[];
  fieldConversation: InboundConversationField;
  includeThreadReplies: boolean;
  provider: MessagingChannelKind;
  replyDestination: AutomationSourceMessageDestination;
  resultMode: ResultMode;
  schedule?: AutomationScheduleDefinition;
  /** Every source to watch, in list order, the fields' one included. */
  sources: readonly AutomationMessagingConversationSnapshot[];
  target?: AutomationMessagingConversationSnapshot;
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

  // Empty fields are fine once another conversation is already watched: the
  // operator pressed "Watch another" and then chose not to add one. A
  // half-filled field (a topic scope with no topic) is still an error.
  const field = params.fieldConversation;
  if (field.kind === "incomplete") {
    return { error: field.error, ok: false };
  }
  if (field.kind === "empty" && params.sources.length === 0) {
    return {
      error:
        params.provider === "telegram"
          ? "Choose a group or enter a group ID."
          : "Conversation ID is required.",
      ok: false,
    };
  }
  // A row whose value is blank cannot be evaluated, so it is rejected here
  // rather than saved as an inert filter the operator believes is active.
  const incomplete = params.conditionGroup.conditions.some(
    (condition) => condition.values.every((value) => value.trim().length === 0),
  );
  if (incomplete) {
    return {
      error: "Every condition needs a value, or remove the empty row.",
      ok: false,
    };
  }
  if (params.conditionGroup.conditions.length === 0) {
    return {
      error:
        "Add at least one condition — without one this runs on every message in the conversation.",
      ok: false,
    };
  }
  if (params.resultMode === "different" && !params.target) {
    return {
      error: "Choose where to send the result, or pick a different option.",
      ok: false,
    };
  }

  const sources = params.sources;
  const conditionGroup = params.conditionGroup;
  const name = formatAutomationInboundConditionGroup(conditionGroup);

  const outputActions: NonNullable<CreateAutomationRequest["outputActions"]> = [
    { id: "agent-context", kind: "agent_context" },
  ];
  if (params.resultMode === "reply_source") {
    outputActions.push({
      broadcast: params.broadcast,
      destination: params.replyDestination,
      id: "source-thread-reply",
      kind: "source_message",
    });
  } else if (params.resultMode === "different" && params.target) {
    outputActions.push({
      id: "messaging-target",
      kind: "messaging_target",
      target: params.target,
    });
  }

  // One trigger per source, all carrying the one filter this form edits. The
  // matcher already walks every trigger, so a message in any of them fires.
  const ids = assignInboundTriggerIds(sources, params.existingTriggers);
  return {
    ok: true,
    outputActions,
    triggers: sources.map((conversation, index) => ({
      conditionGroup,
      conversation,
      id: ids[index],
      includeThreadReplies: params.includeThreadReplies,
      kind: "inbound_message" as const,
      name,
    })),
  };
}

/**
 * A watched conversation's name, prefixed with its provider when the list it
 * appears in spans providers. Callers decide `withProvider`: naming it on every
 * entry of a single-provider list repeats itself and says nothing.
 */
export function formatInboundSourceLabel(
  source: AutomationMessagingConversationSnapshot,
  options: { withProvider: boolean },
): string {
  const label = formatAutomationConversationLabel(source);
  return options.withProvider
    ? `${INBOUND_PROVIDER_LABELS[source.channel] ?? source.channel} · ${label}`
    : label;
}

/** Which watched conversation a previewed message arrived in. */
function formatPreviewSourceLabel(
  message: InboundPreviewMessage,
  sources: readonly AutomationMessagingConversationSnapshot[],
): string {
  const source = sources[findAutomationConversationIndexForMessage(sources, message)];
  return source ? formatAutomationConversationLabel(source) : message.conversationId;
}

type InboundConversationField =
  | { kind: "empty" }
  | { error: string; kind: "incomplete" }
  | { conversation: AutomationMessagingConversationSnapshot; kind: "complete" };

/**
 * The conversation the trigger fields describe, if they describe one. Kept
 * apart from validation so the same reading feeds the save, the live preview,
 * and "Watch another", and none of them can disagree about what is selected.
 */
function readInboundConversation(params: {
  groupId: string;
  groupTitle?: string;
  provider: MessagingChannelKind;
  telegramScope: TelegramScope;
  topicId: string;
  topicTitle?: string;
}): InboundConversationField {
  const groupId = params.groupId.trim();
  const topicId = params.topicId.trim();
  const isTopic =
    params.provider === "telegram" && params.telegramScope === "topic"
    && !isContactSelection(groupId);
  if (!groupId) return { kind: "empty" };
  if (isTopic && !topicId) {
    return { error: "Enter a topic ID or switch to Whole group.", kind: "incomplete" };
  }
  const conversation: AutomationMessagingConversationSnapshot | undefined = isTopic
    ? {
        channel: params.provider,
        conversationId: topicId,
        conversationKind: "topic",
        parentId: groupId,
        ...(params.topicTitle ? { title: params.topicTitle } : {}),
        ...(params.groupTitle ? { parentTitle: params.groupTitle } : {}),
      }
    : buildDestinationSnapshot({ ...params, topicId: "" });
  if (!conversation) {
    return { error: "Choose a conversation or DM recipient.", kind: "incomplete" };
  }
  return { kind: "complete", conversation };
}

/**
 * The field values that describe a stored conversation — the inverse of
 * `readInboundConversation`, and the same derivation the editor's initial
 * state uses for the automation's first source.
 */
function fieldValuesFor(conversation: AutomationMessagingConversationSnapshot): {
  groupId: string;
  manualKind: ManualSurfaceKind;
  telegramScope: TelegramScope;
  topicId: string;
} {
  if (conversation.conversationKind === "topic") {
    return {
      groupId: conversation.parentId ?? "",
      manualKind: "channel",
      telegramScope: "topic",
      topicId: conversation.conversationId,
    };
  }
  if (conversation.recipientUserId) {
    return {
      groupId: contactSelection(conversation.recipientUserId),
      manualKind: "dm",
      telegramScope: "group",
      topicId: "",
    };
  }
  return {
    groupId: conversation.conversationId,
    manualKind: "channel",
    telegramScope: "group",
    topicId: "",
  };
}

/** First occurrence wins, so a source keeps its position and its title. */
function dedupeConversations(
  conversations: readonly AutomationMessagingConversationSnapshot[],
): AutomationMessagingConversationSnapshot[] {
  const seen = new Set<string>();
  return conversations.filter((conversation) => {
    const key = automationConversationKey(conversation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Stable trigger ids. A source the automation already watched keeps the id it
 * was stored with — including the fixed "inbound-message" every automation
 * written before multi-source had — so re-saving an unchanged automation
 * rewrites no ids. A new source gets an id derived from its conversation.
 */
function assignInboundTriggerIds(
  sources: readonly AutomationMessagingConversationSnapshot[],
  existing: readonly AutomationInboundMessageTriggerDefinition[],
): string[] {
  const storedIdByKey = new Map<string, string>();
  for (const trigger of existing) {
    const key = automationConversationKey(trigger.conversation);
    if (!storedIdByKey.has(key)) storedIdByKey.set(key, trigger.id);
  }
  // Every kept id is claimed before any new one is derived, so a derived id
  // that happens to equal a kept one is the one that yields — never the
  // source that already had it.
  const stored = sources.map((conversation) =>
    storedIdByKey.get(automationConversationKey(conversation)),
  );
  const used = new Set(stored.filter((id): id is string => id !== undefined));
  return sources.map((conversation, index) => {
    const kept = stored[index];
    if (kept !== undefined) return kept;
    const base = buildAutomationInboundTriggerId(conversation);
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}:${suffix}`;
    used.add(id);
    return id;
  });
}

/**
 * The picker reports its manual row as "manual"; this editor's selection
 * state uses a sentinel chosen not to collide with a real conversation ID.
 * Translate at the boundary rather than widening either one.
 */
function pickerValue(selection: string): string {
  return selection === MANUAL_GROUP_VALUE ? "manual" : selection;
}

function selectionValue(picked: string): string {
  return picked === "manual" ? MANUAL_GROUP_VALUE : picked;
}

/**
 * Authorized groups, channels and topics all arrive as `{id, title}`. The ID
 * rides in the picker's mono column so two similarly titled destinations stay
 * distinguishable — except when the title IS the ID, where repeating it would
 * be noise.
 */
function conversationOptions(
  entries: ReadonlyArray<{ id: string; title: string; kind?: MessagingConversationKind }>,
): Array<{
  value: string;
  label: string;
  detail?: string;
  kind?: MessagingConversationKind;
}> {
  return entries.map((entry) => {
    // `dm:` is how this editor tells a contact from a conversation in its own
    // state. It is not an identifier anyone can paste into Slack or Telegram,
    // and the ID column exists so two same-named rows can be told apart by
    // something durable — so the column gets the platform ID, never the
    // sentinel. Strip it here rather than at the source: every other consumer
    // (`buildDestinationSnapshot`, the Telegram scope guard, `previewScope`)
    // reads the prefixed form.
    const platformId = contactUserId(entry.id) ?? entry.id;
    return {
      value: entry.id,
      label: entry.title,
      // A contact PwrAgent has no name for is labelled with its own ID; a
      // column repeating it is noise, and worse, reads as a second identifier.
      detail: entry.title === platformId ? undefined : platformId,
      ...(entry.kind ? { kind: entry.kind } : {}),
    };
  });
}

/**
 * How a picker or manual-entry value says "this person's DM" rather than "this
 * conversation". Every read and write of the marker goes through these three,
 * so the encoding lives in one place.
 */
const CONTACT_SELECTION_PREFIX = "dm:";

function contactSelection(userId: string): string {
  return `${CONTACT_SELECTION_PREFIX}${userId}`;
}

function isContactSelection(value: string): boolean {
  return value.startsWith(CONTACT_SELECTION_PREFIX);
}

/**
 * The platform user ID inside a contact selection, or undefined when the value
 * addresses a shared conversation (or is a contact selection with no ID yet).
 */
function contactUserId(value: string): string | undefined {
  if (!isContactSelection(value)) return undefined;
  const userId = value.slice(CONTACT_SELECTION_PREFIX.length).trim();
  return userId || undefined;
}

/**
 * Every word the picker shows, in this provider's vocabulary. The list is the
 * operator's authorized conversations, not everything the bot has seen, so the
 * heading says so — a short list is then explained rather than suspicious.
 */
function conversationPickerLabels(
  provider: MessagingChannelKind,
  side: "trigger" | "destination",
): {
  placeholder: string;
  searchPlaceholder: string;
  manualLabel: string;
  sectionLabels: { channel: string; dm: string };
  emptyLabel: string;
} {
  const noun = conversationPickerLabel(provider).toLowerCase();
  return {
    placeholder: `Choose a ${noun} or DM`,
    searchPlaceholder: `Find a ${noun}, DM, or ID`,
    manualLabel: `Enter ${conversationLabel(provider)} manually...`,
    // The headings say what the list is drawn from, so a short list is
    // explained rather than suspicious. Discord authorizes servers, not
    // channels, so its channels are not "authorized" one by one. A contact
    // row means messages FROM that person on the trigger side — the matcher
    // compares the sender — and messages TO them on the destination side.
    sectionLabels: {
      channel: provider === "discord"
        ? "Channels in authorized servers"
        : `Authorized ${noun}s`,
      dm: side === "trigger" ? "Direct messages from" : "Direct messages to",
    },
    emptyLabel: "No matching conversations.",
  };
}

/**
 * Which kind of surface a manually typed ID names. The picker carries this in
 * the option it was built from; manual entry has to be told.
 */
type ManualSurfaceKind = "channel" | "dm";

/** The bare ID a manual field shows, with the editor's `dm:` marker removed. */
function manualSurfaceValue(stored: string): string {
  return contactUserId(stored) ?? (isContactSelection(stored) ? "" : stored);
}

/**
 * Store a typed ID under the selected kind. Toggling the switch re-encodes
 * what is already there rather than clearing it, so an operator who picks the
 * wrong kind first does not retype the ID.
 */
function encodeManualSurface(kind: ManualSurfaceKind, value: string): string {
  const raw = manualSurfaceValue(value);
  return kind === "dm" && raw ? contactSelection(raw) : raw;
}

/**
 * A DM trigger matches on the SENDER's platform user ID, not on the
 * conversation's — `matchesAutomationConversation` compares `recipientUserId`
 * against the actor. These three say so, because every provider also has a
 * separate DM conversation ID that is the wrong answer here and is usually the
 * easier one to find.
 */
function recipientLabel(provider: MessagingChannelKind): string {
  if (provider === "slack") return "Member ID";
  if (provider === "feishu") return "Open ID";
  return "User ID";
}

function recipientPlaceholder(provider: MessagingChannelKind): string {
  if (provider === "telegram") return "e.g. 123456789";
  if (provider === "slack") return "e.g. U0123ABCD";
  if (provider === "discord") return "e.g. 123456789012345678";
  if (provider === "feishu") return "e.g. ou_9c1f2a...";
  if (provider === "line") return "e.g. U4af4980629...";
  if (provider === "mattermost") return "e.g. 8f3k2j1h9g8f7d6s5a4q3w2e1r";
  return "e.g. a user ID";
}

function recipientHint(provider: MessagingChannelKind): string {
  if (provider === "telegram") {
    return "The person's numeric Telegram user ID, and they must have started a chat with the bot. Authorize them in Settings > Messaging to pick them from the list instead.";
  }
  if (provider === "slack") {
    return "The Slack member ID of the person whose DMs should trigger this — open their profile and copy the member ID. Not the D... conversation ID.";
  }
  if (provider === "discord") {
    return "The Discord user ID. Enable Developer Mode, then right-click the person and Copy User ID. Not the DM channel ID.";
  }
  if (provider === "feishu") {
    return "The person's Feishu/Lark open_id for this app — not the p2p chat_id.";
  }
  if (provider === "line") {
    return "The person's LINE user ID (starts with U). Not a group or room ID.";
  }
  if (provider === "mattermost") {
    return "The Mattermost user ID, a 26-character lowercase string — not their @username, and not the DM channel ID.";
  }
  return "The platform user ID of the person whose direct messages should trigger this.";
}

/**
 * The provider's own noun for a shared conversation. Feeds the picker's
 * placeholder, search and section heading, and the manual switch's first
 * button, so it has to be the word an operator of that platform would use.
 */
function conversationPickerLabel(provider: MessagingChannelKind): string {
  if (provider === "telegram") return "Group";
  if (provider === "feishu") return "Group chat";
  // LINE rooms share this list; the ID field and its hint say so.
  if (provider === "line") return "Group";
  return "Channel";
}

// Lowercase only the leading word so "Group ID" reads as "group ID" after a
// "Destination " prefix, keeping the "ID" suffix capitalized like the inbound
// field's "Group ID"/"Channel ID" labels.
function lowerLead(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function conversationLabel(provider: MessagingChannelKind): string {
  if (provider === "telegram") return "Group ID";
  if (provider === "feishu") return "Chat ID";
  if (provider === "line") return "Group or room ID";
  if (provider === "slack" || provider === "discord" || provider === "mattermost") {
    return "Channel ID";
  }
  return "Conversation ID";
}

function conversationPlaceholder(provider: MessagingChannelKind): string {
  if (provider === "telegram") return "e.g. -1001234567890";
  if (provider === "slack") return "e.g. C0123ABCD";
  if (provider === "discord") return "e.g. 123456789012345678";
  if (provider === "mattermost") return "e.g. 8f3k2j1h9g8f7d6s5a4q3w2e1r";
  if (provider === "feishu") return "e.g. oc_a0553eda9014c201e6969b478895c230";
  if (provider === "line") return "e.g. C4af4980629...";
  return "e.g. a conversation ID";
}

function conversationHint(provider: MessagingChannelKind): string {
  if (provider === "telegram") {
    return "The supergroup ID (a negative number). Add the bot to the group and pair it from Settings > Messaging, then pick it above.";
  }
  if (provider === "slack") {
    return "The Slack channel ID. In Slack, open the channel details and copy the ID at the bottom, or copy a message link and take the C... segment.";
  }
  if (provider === "discord") {
    return "The Discord channel ID. Enable Developer Mode, then right-click the channel and Copy Channel ID. The channel's server must be authorized in Settings > Messaging.";
  }
  if (provider === "mattermost") {
    return "The Mattermost channel ID, a 26-character lowercase string — not the channel name in its URL.";
  }
  if (provider === "feishu") {
    return "The Feishu/Lark group chat_id, which starts with oc_. Not a person's open_id.";
  }
  if (provider === "line") {
    return "The LINE group ID (starts with C) or room ID (starts with R). Not a user ID.";
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

function initialResultMode(automation: AutomationDetail | undefined): ResultMode {
  if (!automation) return "reply_source";
  const actions = automation.outputActions;
  if (actions.some((action) => action.kind === "messaging_target")) {
    return "different";
  }
  if (actions.some((action) => action.kind === "source_message")) {
    return "reply_source";
  }
  return "agent_only";
}

function initialReplySubDestination(
  automation: AutomationDetail | undefined,
): AutomationSourceMessageDestination {
  const source = automation?.outputActions.find(
    (action) => action.kind === "source_message",
  );
  return source && source.kind === "source_message"
    ? source.destination
    : "source_thread";
}

function buildDestinationSnapshot(params: {
  groupId: string;
  groupTitle?: string;
  provider: MessagingChannelKind;
  topicId: string;
}): AutomationMessagingConversationSnapshot | undefined {
  const groupId = params.groupId.trim();
  if (!groupId) return undefined;
  if (isContactSelection(groupId)) {
    const userId = contactUserId(groupId);
    if (!userId) return undefined;
    return {
      channel: params.provider,
      conversationId: userId,
      conversationKind: "dm",
      recipientUserId: userId,
      ...(params.groupTitle ? { title: params.groupTitle } : {}),
    };
  }
  const topicId = params.topicId.trim();
  if (params.provider === "telegram" && topicId) {
    return {
      channel: params.provider,
      conversationId: topicId,
      conversationKind: "topic",
      parentId: groupId,
      ...(params.groupTitle ? { parentTitle: params.groupTitle } : {}),
    };
  }
  return {
    channel: params.provider,
    conversationId: groupId,
    conversationKind: "channel",
    ...(params.groupTitle ? { title: params.groupTitle } : {}),
  };
}

function readEnabledProviders(
  snapshot: DesktopMessagingSettingsProjection,
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

/**
 * The conversations an automation may watch or reply to, per provider.
 *
 * Every provider names its conversation list differently, and each also keeps
 * an `authorizedUserIds` list — the people the bot will talk to one-to-one.
 * Those are DMs, and leaving them out meant an automation could never watch or
 * answer a direct message. The container lists (`authorizedGuilds`,
 * `authorizedWorkspaces`, `authorizedTeams`, `authorizedTenants`) are servers
 * and workspaces rather than conversations, so nothing here reads them —
 * Discord's channels are listed from its API per server instead
 * (`readDiscordServers` / `buildDiscordChannelCatalog`).
 */
function readProviderGroups(
  snapshot: DesktopMessagingSettingsProjection,
): ProviderGroups {
  const messaging = snapshot.messaging;
  const toConversation =
    (kind: MessagingConversationKind) =>
    (contact: { id: string; displayName?: string }): ProviderConversation => ({
      id: kind === "dm" ? contactSelection(contact.id) : contact.id,
      title: contact.displayName ? `${contact.displayName}` : contact.id,
      kind,
    });
  /**
   * Every list here is read defensively. A provider block or an authorized
   * list the snapshot does not carry contributes nothing; without this, one
   * absent key throws and the caller's catch swallows it, leaving every
   * picker empty and every provider looking unconfigured.
   */
  const read = (
    list: { value?: Array<{ id: string; displayName?: string }> } | undefined,
    kind: MessagingConversationKind,
  ): ProviderConversation[] => (list?.value ?? []).map(toConversation(kind));

  // Partial by design: `MessagingChannelKind` covers more providers than have
  // a Settings screen, and one without an authorized list simply has no
  // conversations to offer.
  const byProvider: ProviderGroups = {
    telegram: [
      ...read(messaging.telegram?.authorizedSupergroups, "channel"),
      ...read(messaging.telegram?.authorizedUserIds, "dm"),
    ],
    // Discord's only authorized list is of guilds, which are servers rather
    // than conversations; its channels are discovered per-guild elsewhere.
    discord: read(messaging.discord?.authorizedUserIds, "dm"),
    slack: [
      ...read(messaging.slack?.authorizedChannels, "channel"),
      ...read(messaging.slack?.authorizedUserIds, "dm"),
    ],
    mattermost: [
      ...read(messaging.mattermost?.authorizedConversations, "channel"),
      ...read(messaging.mattermost?.authorizedUserIds, "dm"),
    ],
    feishu: [
      ...read(messaging.feishu?.authorizedChats, "channel"),
      ...read(messaging.feishu?.authorizedUserIds, "dm"),
    ],
    line: [
      // A LINE "room" is a multi-person chat without a group identity — a
      // group DM in every way that matters here.
      ...read(messaging.line?.authorizedGroups, "channel"),
      ...read(messaging.line?.authorizedRooms, "channel"),
      ...read(messaging.line?.authorizedUserIds, "dm"),
    ],
  };

  const groups: ProviderGroups = {};
  for (const [provider, conversations] of Object.entries(byProvider)) {
    if (conversations && conversations.length > 0) {
      groups[provider as MessagingChannelKind] = conversations;
    }
  }
  return groups;
}

/** The Discord servers PwrAgent is authorized in, whose channels can be listed. */
function readDiscordServers(
  snapshot: DesktopMessagingSettingsProjection,
): DiscordServer[] {
  return (snapshot.messaging.discord?.authorizedGuilds?.value ?? []).map((server) => ({
    id: server.id,
    ...(server.displayName ? { name: server.displayName } : {}),
  }));
}

/**
 * Turn per-server listings into picker rows plus one sentence per server that
 * Discord would not list. A server that fails still leaves the others usable
 * and the manual field reachable, so a failure is reported, never fatal.
 *
 * Rows read "Server / channel", the separator Messaging Routes uses for the
 * same surfaces: two servers routinely both have a `#general`, and the ID
 * column alone is a poor way to tell which one an operator meant.
 */
function buildDiscordChannelCatalog(
  key: string,
  results: Array<
    | { server: DiscordServer; response: ListDiscordThreadPermissionChannelsResponse }
    | { server: DiscordServer; error: string }
  >,
): DiscordChannelCatalog {
  const channels: ProviderConversation[] = [];
  const issues: string[] = [];
  let tokenMissing = false;
  for (const result of results) {
    const serverName = "response" in result
      ? result.response.guildName ?? result.server.name ?? result.server.id
      : result.server.name ?? result.server.id;
    if (!("response" in result)) {
      issues.push(`${serverName}: ${result.error}`);
      continue;
    }
    if (result.response.status === "unset") {
      tokenMissing = true;
      continue;
    }
    if (result.response.status === "failed") {
      issues.push(
        `${serverName}: ${result.response.errorMessage ?? "Discord did not return its channels."}`,
      );
      continue;
    }
    for (const channel of result.response.channels) {
      channels.push({
        id: channel.id,
        title: `${serverName} / ${channel.name}`,
        kind: "channel",
      });
    }
  }
  if (tokenMissing) {
    // Every server answers "unset" when there is no token, so say it once.
    issues.unshift("Discord has no bot token, so no server's channels can be listed.");
  }
  return { key, channels, issues };
}

/**
 * What the preview can say about history before it opens. Only the scope
 * refusals are knowable here — `supportsPreviewHistory` in the main process
 * refuses a contact recipient or a parented scope on every provider — so only
 * they are stated up front. Whether the PROVIDER reads history is answered by
 * the main process when the preview starts, and stated then.
 */
function previewScopeHistoryNote(
  scope: AutomationMessagingConversationSnapshot | undefined,
): string | undefined {
  if (scope?.recipientUserId) {
    return "History can't be read back for a contact's direct messages, so the preview shows new messages only.";
  }
  if (scope?.parentId) {
    return "History is read for whole conversations, not one topic, so the preview shows new messages only.";
  }
  return undefined;
}

/**
 * A platform rule that decides whether a group trigger sees ordinary
 * messages at all. PwrAgent cannot change either setting, and neither
 * produces an error — the automation simply never fires — so the editor says
 * so where the group is chosen. Static on purpose: Telegram's flag is not
 * decisive on its own (an admin bot receives everything anyway), and Feishu
 * does not report the permission to the bot.
 */
function groupDeliveryHint(provider: MessagingChannelKind): string | undefined {
  if (provider === "telegram") {
    return "Telegram only delivers ordinary group messages to a bot whose Group Privacy is turned off in @BotFather, or that is an admin of the group. Otherwise this automation sees only commands, mentions, and replies to the bot.";
  }
  if (provider === "feishu") {
    return "Feishu/Lark delivers group messages that don't @mention the bot only if the app has the \"read all group messages\" permission (im:message.group_msg). Otherwise this automation sees only messages that @mention it.";
  }
  return undefined;
}

/**
 * What the Discord list is drawn from, and what went wrong drawing it. Without
 * this, a server whose channels failed to list looks like a server with no
 * channels, and having no authorized server looks like a broken picker.
 */
function DiscordChannelHint(props: {
  canList: boolean;
  catalog: DiscordChannelCatalog | undefined;
  servers: DiscordServer[] | undefined;
}) {
  if (!props.canList || !props.servers) return null;
  if (props.servers.length === 0) {
    return (
      <p className="automation-field__hint">
        PwrAgent lists channels from the Discord servers it is authorized in, and
        none are authorized yet. Authorize a server in Settings &gt; Messaging, or
        enter a channel ID.
      </p>
    );
  }
  if (!props.catalog) {
    return (
      <p className="automation-field__hint">
        Listing channels from authorized servers...
      </p>
    );
  }
  if (props.catalog.issues.length === 0) return null;
  const issues = props.catalog.issues
    .map((issue) => (/[.!?]$/.test(issue) ? issue : `${issue}.`))
    .join(" ");
  return (
    <p className="automation-field__hint">
      Some channels could not be listed. {issues} You can still enter a channel ID.
    </p>
  );
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
