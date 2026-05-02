import type {
  AppServerBackendKind,
  AppServerThreadImagePart,
  AppServerThreadMessagePart,
  AppServerThreadSummary,
  ThreadIdentifier,
  ThreadExecutionMode,
  NavigationDirectorySummary,
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragnt/shared";

export const MESSAGING_SURFACE_INTENT_KINDS = [
  "activity",
  "message",
  "status",
  "progress",
  "thread_picker",
  "project_picker",
  "single_select",
  "multi_select",
  "questionnaire",
  "approval",
  "confirmation",
  "error",
  "dismiss",
] as const;

export const MESSAGING_INBOUND_EVENT_KINDS = [
  "text",
  "command",
  "callback",
  "media",
  "lifecycle",
] as const;

export const MESSAGING_DELIVERY_OUTCOMES = [
  "presented",
  "updated",
  "presented_new",
  "signaled",
  "pinned",
  "unpinned",
  "dismissed",
  "unsupported",
  "failed",
] as const;

export const MESSAGING_TOOL_UPDATE_MODES = [
  "show_none",
  "show_less",
  "show_some",
  "show_more",
  "show_all",
] as const;

export type MessagingSurfaceIntentKind =
  (typeof MESSAGING_SURFACE_INTENT_KINDS)[number];
export type MessagingInboundEventKind =
  (typeof MESSAGING_INBOUND_EVENT_KINDS)[number];
export type MessagingDeliveryOutcome =
  (typeof MESSAGING_DELIVERY_OUTCOMES)[number];
export type MessagingToolUpdateMode =
  (typeof MESSAGING_TOOL_UPDATE_MODES)[number];

export type MessagingChannelKind =
  | "telegram"
  | "discord"
  | "slack"
  | "mattermost"
  | "feishu"
  | "googlechat"
  | "msteams"
  | "matrix"
  | "irc"
  | "imessage"
  | "signal"
  | "whatsapp"
  | "line"
  | "zalo"
  | "nextcloud-talk"
  | "synology-chat"
  | "twitch"
  | "nostr"
  | "qqbot"
  | "bluebubbles"
  | "tlon"
  | "voice-call"
  | "custom";

export type MessagingJsonPrimitive = string | number | boolean | null;
export type MessagingJsonValue =
  | MessagingJsonPrimitive
  | MessagingJsonValue[]
  | { [key: string]: MessagingJsonValue };

export type MessagingConversationKind = "dm" | "channel" | "thread" | "topic";

export type MessagingConversationRef = {
  id: string;
  kind: MessagingConversationKind;
  parentId?: string;
  title?: string;
};

export type MessagingActorIdentity = {
  platformUserId: string;
  displayName?: string;
  username?: string;
  isBot?: boolean;
};

export type MessagingChannelRef = {
  channel: MessagingChannelKind;
  conversation: MessagingConversationRef;
};

export type MessagingAdapterState = {
  /**
   * Adapter-owned data needed to route, update, dismiss, or correlate a
   * channel surface. Core workflow code may persist and echo this value, but
   * must not parse it.
   */
  opaque: MessagingJsonValue;
};

export type MessagingSurfaceRef = {
  channel: MessagingChannelKind;
  id: string;
  state?: MessagingAdapterState;
};

export type MessagingInteractionRef = {
  channel: MessagingChannelKind;
  id: string;
  state?: MessagingAdapterState;
};

export type MessagingAuditContext = {
  actor: MessagingActorIdentity;
  bindingId?: string;
  channel: MessagingChannelRef;
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  action?: string;
  occurredAt: number;
};

export type MessagingMarkdownPolicy = "plain" | "light" | "markdown";

export type MessagingTextPart = {
  type: "text";
  text: string;
  markdown?: MessagingMarkdownPolicy;
};

export type MessagingImagePart = AppServerThreadImagePart & {
  source?: "assistant" | "user" | "system";
};

export type MessagingFilePart = {
  type: "file";
  name: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  description?: string;
};

export type MessagingContentPart =
  | MessagingTextPart
  | MessagingImagePart
  | MessagingFilePart;

export type MessagingActionStyle =
  | "primary"
  | "secondary"
  | "danger"
  | "navigation";

export type MessagingActionLayoutHint = {
  /**
   * Absolute row placement for providers with button rows. Actions with the same
   * row share a row when the provider supports it.
   */
  row?: number;
  /**
   * Optional ordering within an explicit row.
   */
  column?: number;
  /**
   * Start a new provider row before this action when rows are supported.
   */
  rowBreakBefore?: boolean;
  /**
   * Start a new provider row after this action when rows are supported.
   */
  rowBreakAfter?: boolean;
  /**
   * Prefer this action on a row by itself.
   */
  width?: "auto" | "full";
};

export type MessagingSurfaceAction = {
  id: string;
  label: string;
  description?: string;
  style?: MessagingActionStyle;
  layout?: MessagingActionLayoutHint;
  value?: MessagingJsonValue;
  disabled?: boolean;
  fallbackText?: string;
};

export function layoutMessagingActionRows<T>(
  items: Array<{
    action: MessagingSurfaceAction;
    component: T;
  }>,
  options: {
    defaultColumns?: number;
    maxColumns: number;
    maxRows?: number;
  },
): T[][] {
  const maxColumns = Math.max(1, Math.floor(options.maxColumns));
  const explicitRows = new Map<
    number,
    Array<{
      action: MessagingSurfaceAction;
      component: T;
      index: number;
    }>
  >();
  const automaticItems: Array<{
    action: MessagingSurfaceAction;
    component: T;
  }> = [];

  items.forEach((item, index) => {
    const row = item.action.layout?.row;
    if (typeof row === "number" && Number.isInteger(row) && row >= 0) {
      const entries = explicitRows.get(row) ?? [];
      entries.push({ ...item, index });
      explicitRows.set(row, entries);
      return;
    }
    automaticItems.push(item);
  });

  const rows: T[][] = [];
  for (const row of [...explicitRows.keys()].sort((left, right) => left - right)) {
    const components = explicitRows
      .get(row)!
      .sort((left, right) => {
        const leftColumn = left.action.layout?.column;
        const rightColumn = right.action.layout?.column;
        if (typeof leftColumn === "number" && typeof rightColumn === "number") {
          return leftColumn - rightColumn;
        }
        if (typeof leftColumn === "number") {
          return -1;
        }
        if (typeof rightColumn === "number") {
          return 1;
        }
        return left.index - right.index;
      })
      .map((item) => item.component);
    rows.push(...chunkRow(components, maxColumns));
  }

  rows.push(...layoutAutomaticActionRows(automaticItems, {
    defaultColumns: options.defaultColumns,
    maxColumns,
  }));

  return typeof options.maxRows === "number" ? rows.slice(0, options.maxRows) : rows;
}

export type MessagingChoice = MessagingSurfaceAction & {
  recommended?: boolean;
};

function layoutAutomaticActionRows<T>(
  items: Array<{
    action: MessagingSurfaceAction;
    component: T;
  }>,
  options: {
    defaultColumns?: number;
    maxColumns: number;
  },
): T[][] {
  const defaultColumns = Math.max(
    1,
    Math.min(options.maxColumns, Math.floor(options.defaultColumns ?? options.maxColumns)),
  );
  const rows: T[][] = [];
  let currentRow: T[] = [];

  const flush = (): void => {
    if (currentRow.length === 0) {
      return;
    }
    rows.push(currentRow);
    currentRow = [];
  };

  for (const item of items) {
    const fullWidth = item.action.layout?.width === "full";
    if (item.action.layout?.rowBreakBefore || fullWidth) {
      flush();
    }

    currentRow.push(item.component);

    if (
      fullWidth
      || item.action.layout?.rowBreakAfter
      || currentRow.length >= defaultColumns
    ) {
      flush();
    }
  }

  flush();
  return rows.flatMap((row) => chunkRow(row, options.maxColumns));
}

function chunkRow<T>(row: T[], maxColumns: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < row.length; index += maxColumns) {
    chunks.push(row.slice(index, index + maxColumns));
  }
  return chunks;
}

export type MessagingPickerPage<TItem> = {
  items: TItem[];
  pageIndex: number;
  pageSize: number;
  totalItems?: number;
  filter?: string;
  actions: MessagingSurfaceAction[];
};

export type MessagingQuestionnaireQuestion = {
  id: string;
  header?: string;
  question: string;
  options: MessagingChoice[];
  allowFreeform?: boolean;
  secret?: boolean;
};

export type MessagingApprovalDecision =
  | "accept"
  | "accept_for_session"
  | "decline"
  | "cancel";

export type MessagingSurfacePresentationMode = "present" | "update" | "dismiss";

export type MessagingSurfaceDeliveryPolicy = {
  mode?: MessagingSurfacePresentationMode;
  pin?: boolean;
  replaceMarkup?: boolean;
  unpin?: boolean;
  fallback?: "present_new" | "fail";
};

export type MessagingActionLayoutPolicy = {
  /**
   * Preferred automatic column count for actions without explicit row placement.
   * Providers may clamp or ignore this based on native limits.
   */
  columns?: number;
};

export type MessagingBaseSurfaceIntent = {
  id: string;
  kind: MessagingSurfaceIntentKind;
  actionLayout?: MessagingActionLayoutPolicy;
  audit?: MessagingAuditContext;
  bindingId?: string;
  createdAt: number;
  delivery?: MessagingSurfaceDeliveryPolicy;
  fallbackText?: string;
  requestContext?: {
    backend: AppServerBackendKind;
    method: string;
    requestId: string;
    threadId: ThreadIdentifier;
    turnId?: string;
  };
  targetSurface?: MessagingSurfaceRef;
};

export type MessagingMessageIntent = MessagingBaseSurfaceIntent & {
  kind: "message";
  parts: MessagingContentPart[];
  role?: "assistant" | "user" | "system";
};

export type MessagingActivityIntent = MessagingBaseSurfaceIntent & {
  kind: "activity";
  activity: "typing";
  leaseMs?: number;
  state: "active" | "idle";
};

export type MessagingStatusIntent = MessagingBaseSurfaceIntent & {
  kind: "status";
  status: "idle" | "working" | "waiting" | "completed" | "failed";
  text: string;
  actions?: MessagingSurfaceAction[];
};

export type MessagingProgressIntent = MessagingBaseSurfaceIntent & {
  kind: "progress";
  label: string;
  detail?: string;
  value?: number;
  max?: number;
};

export type MessagingThreadPickerIntent = MessagingBaseSurfaceIntent & {
  kind: "thread_picker";
  navigation: Pick<NavigationSnapshot, "backend" | "fetchedAt" | "unchanged">;
  page: MessagingPickerPage<NavigationThreadSummary | AppServerThreadSummary>;
  prompt: string;
};

export type MessagingProjectPickerIntent = MessagingBaseSurfaceIntent & {
  kind: "project_picker";
  navigation: Pick<NavigationSnapshot, "backend" | "fetchedAt" | "unchanged">;
  page: MessagingPickerPage<NavigationDirectorySummary>;
  prompt: string;
};

export type MessagingSingleSelectIntent = MessagingBaseSurfaceIntent & {
  kind: "single_select";
  prompt: string;
  choices: MessagingChoice[];
};

export type MessagingMultiSelectIntent = MessagingBaseSurfaceIntent & {
  kind: "multi_select";
  prompt: string;
  choices: MessagingChoice[];
  minSelected?: number;
  maxSelected?: number;
};

export type MessagingQuestionnaireIntent = MessagingBaseSurfaceIntent & {
  kind: "questionnaire";
  currentIndex: number;
  questions: MessagingQuestionnaireQuestion[];
};

export type MessagingApprovalIntent = MessagingBaseSurfaceIntent & {
  kind: "approval";
  title: string;
  body: string;
  decisions: Array<MessagingSurfaceAction & { decision: MessagingApprovalDecision }>;
};

export type MessagingConfirmationIntent = MessagingBaseSurfaceIntent & {
  kind: "confirmation";
  title: string;
  body: string;
  actions: MessagingSurfaceAction[];
};

export type MessagingErrorIntent = MessagingBaseSurfaceIntent & {
  kind: "error";
  title: string;
  body: string;
  recoverable?: boolean;
};

export type MessagingDismissIntent = MessagingBaseSurfaceIntent & {
  kind: "dismiss";
  reason?: string;
  targetSurface: MessagingSurfaceRef;
};

export type MessagingSurfaceIntent =
  | MessagingActivityIntent
  | MessagingMessageIntent
  | MessagingStatusIntent
  | MessagingProgressIntent
  | MessagingThreadPickerIntent
  | MessagingProjectPickerIntent
  | MessagingSingleSelectIntent
  | MessagingMultiSelectIntent
  | MessagingQuestionnaireIntent
  | MessagingApprovalIntent
  | MessagingConfirmationIntent
  | MessagingErrorIntent
  | MessagingDismissIntent;

export type MessagingDeliveryResult = {
  outcome: MessagingDeliveryOutcome;
  channel: MessagingChannelKind;
  surface?: MessagingSurfaceRef;
  errorMessage?: string;
  deliveredAt: number;
};

export type MessagingConversationTitleUpdateRequest = {
  actor?: MessagingActorIdentity;
  channel: MessagingChannelRef;
  routingState?: MessagingAdapterState;
  title: string;
};

export type MessagingConversationTitleUpdateResult = {
  channel: MessagingChannelKind;
  conversation: MessagingConversationRef;
  errorMessage?: string;
  outcome: "updated" | "unsupported" | "failed";
  title: string;
  updatedAt: number;
};

export type MessagingInboundBaseEvent = {
  id: string;
  kind: MessagingInboundEventKind;
  actor: MessagingActorIdentity;
  channel: MessagingChannelRef;
  receivedAt: number;
  routingState?: MessagingAdapterState;
};

export type MessagingInboundTextEvent = MessagingInboundBaseEvent & {
  kind: "text";
  text: string;
};

export type MessagingInboundCommandEvent = MessagingInboundBaseEvent & {
  kind: "command";
  command: string;
  args: string[];
  rawText: string;
};

export type MessagingInboundCallbackEvent = MessagingInboundBaseEvent & {
  kind: "callback";
  interaction: MessagingInteractionRef;
  actionId?: string;
  value?: MessagingJsonValue;
};

export type MessagingInboundMediaEvent = MessagingInboundBaseEvent & {
  kind: "media";
  media: MessagingFilePart | AppServerThreadMessagePart;
  disposition: "unsupported";
};

export type MessagingInboundLifecycleEvent = MessagingInboundBaseEvent & {
  kind: "lifecycle";
  lifecycle: "bound" | "detached" | "revoked" | "adapter_started" | "adapter_stopped";
};

export type MessagingInboundEvent =
  | MessagingInboundTextEvent
  | MessagingInboundCommandEvent
  | MessagingInboundCallbackEvent
  | MessagingInboundMediaEvent
  | MessagingInboundLifecycleEvent;

export type MessagingPermissionsMode = "default" | "full-access";

export type MessagingBindingPreferences = {
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  model?: string;
  permissionsMode?: MessagingPermissionsMode;
  reasoningEffort?: string;
  serviceTier?: string;
  toolUpdateMode?: MessagingToolUpdateMode;
  updatedAt: number;
};

export type MessagingActiveTurnSummary = {
  turnId: string;
  status: "working" | "waiting" | "completed" | "failed" | "interrupted";
  startedAt?: number;
  updatedAt: number;
};

export type MessagingThreadDisplaySummary = {
  /**
   * Deprecated migration fallback only. Current thread display facts must be
   * resolved from the desktop navigation/backend state before rendering.
   */
  directoryPath?: string;
  projectLabel?: string;
  threadTitle?: string;
  worktreePath?: string;
};

export type MessagingBindingRecord = {
  id: string;
  channel: MessagingChannelRef;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  authorizedActorIds: string[];
  routingState?: MessagingAdapterState;
  /**
   * Deprecated migration fallback only. Current turn activity is desktop runtime
   * state and must be resolved before rendering or acting.
   */
  activeTurn?: MessagingActiveTurnSummary;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
  displayName?: string;
  pinnedStatusSurface?: MessagingSurfaceRef;
  preferences?: MessagingBindingPreferences;
  statusSurface?: MessagingSurfaceRef;
  threadDisplay?: MessagingThreadDisplaySummary;
};

export type MessagingPendingIntentRecord = {
  id: string;
  bindingId?: string;
  channel?: MessagingChannelRef;
  intent: MessagingSurfaceIntent;
  allowedActorIds: string[];
  createdAt: number;
  expiresAt: number;
  surface?: MessagingSurfaceRef;
};

export type MessagingBrowseMode =
  | "recents"
  | "projects"
  | "project_threads"
  | "new_project"
  | "new_thread_options";

export type MessagingBrowseLaunchAction = "resume_thread" | "start_new_thread";

export type MessagingBrowseSelectedProject = {
  directoryKey?: string;
  label: string;
  path?: string;
};

export type MessagingBrowseSessionRecord = {
  id: string;
  allowedActorIds: string[];
  bindingId?: string;
  channel: MessagingChannelRef;
  createdAt: number;
  expiresAt: number;
  launchAction: MessagingBrowseLaunchAction;
  mode: MessagingBrowseMode;
  pageIndex: number;
  pageSize: number;
  preferences?: MessagingBindingPreferences;
  query?: string;
  selectedProject?: MessagingBrowseSelectedProject;
  surface?: MessagingSurfaceRef;
  updatedAt: number;
};

export type MessagingCallbackHandleRecord = {
  id: string;
  actionId: string;
  allowedActorIds: string[];
  bindingId?: string;
  browseSessionId?: string;
  channel: MessagingChannelRef;
  createdAt: number;
  expiresAt: number;
  handle: string;
  pendingIntentId?: string;
  surface?: MessagingSurfaceRef;
  updatedAt: number;
  value?: MessagingJsonValue;
};

export type MessagingCallbackHandleStore = {
  resolveCallbackHandle(params: {
    actorId: string;
    channel: MessagingChannelRef;
    handle: string;
    now?: number;
  }): Promise<MessagingCallbackHandleRecord | undefined>;
  upsertCallbackHandle(
    callbackHandle: MessagingCallbackHandleRecord,
  ): Promise<MessagingCallbackHandleRecord>;
};
