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
} from "@pwragent/shared";

export const MESSAGING_SURFACE_INTENT_KINDS = [
  "activity",
  "message",
  "stream_update",
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
  "discarded",
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
export type MessagingStreamingResponseMode = "inherit" | "enabled" | "disabled";

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
  data?: Uint8Array;
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
  /** Lower number = higher priority. Actions without priority are dropped first. */
  priority?: number;
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

  type ExplicitEntry = {
    action: MessagingSurfaceAction;
    component: T;
    index: number;
  };

  const rows: T[][] = [];
  let pendingAuto: Array<{
    action: MessagingSurfaceAction;
    component: T;
  }> = [];
  let pendingExplicit: { row: number; entries: ExplicitEntry[] } | null = null;

  const flushAuto = (): void => {
    if (pendingAuto.length === 0) {
      return;
    }
    rows.push(
      ...layoutAutomaticActionRows(pendingAuto, {
        defaultColumns: options.defaultColumns,
        maxColumns,
      }),
    );
    pendingAuto = [];
  };

  const flushExplicit = (): void => {
    if (!pendingExplicit) {
      return;
    }
    const components = pendingExplicit.entries
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
      .map((entry) => entry.component);
    rows.push(...chunkRow(components, maxColumns));
    pendingExplicit = null;
  };

  items.forEach((item, index) => {
    const row = item.action.layout?.row;
    if (typeof row === "number" && Number.isInteger(row) && row >= 0) {
      if (!pendingExplicit || pendingExplicit.row !== row) {
        flushAuto();
        flushExplicit();
        pendingExplicit = { row, entries: [] };
      }
      pendingExplicit.entries.push({ ...item, index });
    } else {
      flushExplicit();
      pendingAuto.push(item);
    }
  });
  flushAuto();
  flushExplicit();

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

export type MessagingStreamUpdateIntent = MessagingBaseSurfaceIntent & {
  kind: "stream_update";
  stream: {
    isFinal: boolean;
    key: string;
    sequence: number;
    itemId?: string;
    turnId?: string;
  };
  delta?: string;
  markdown?: MessagingMarkdownPolicy;
  policy?: MessagingStreamingResponseMode;
  role?: "assistant" | "user" | "system";
  text: string;
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
  browseSessionId?: string;
  navigation: Pick<NavigationSnapshot, "backend" | "fetchedAt" | "unchanged">;
  page: MessagingPickerPage<NavigationThreadSummary | AppServerThreadSummary>;
  prompt: string;
};

export type MessagingProjectPickerIntent = MessagingBaseSurfaceIntent & {
  kind: "project_picker";
  browseSessionId?: string;
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
  | MessagingStreamUpdateIntent
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

export type MessagingAttachmentDisposition =
  | "available"
  | "rejected"
  | "unsupported";

export type MessagingAttachmentKind =
  | "file"
  | "image"
  | "gif"
  | "audio"
  | "video"
  | "unknown";

export type MessagingAttachmentDescriptor = {
  id: string;
  kind: MessagingAttachmentKind;
  name: string;
  disposition: MessagingAttachmentDisposition;
  description?: string;
  height?: number;
  mimeType?: string;
  reason?: string;
  sizeBytes?: number;
  state?: MessagingAdapterState;
  url?: string;
  width?: number;
};

export type MessagingInboundMediaEvent = MessagingInboundBaseEvent & {
  kind: "media";
  attachments: MessagingAttachmentDescriptor[];
  disposition: MessagingAttachmentDisposition;
  media?: MessagingFilePart | AppServerThreadMessagePart;
  text?: string;
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
  streamingResponses?: MessagingStreamingResponseMode;
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

export type MessagingAttachmentDownloadRequest = {
  attachment: MessagingAttachmentDescriptor;
  maxBytes: number;
};

export type MessagingAttachmentDownloadResult = {
  data: Uint8Array;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
};

export type MessagingActionCapabilities = {
  maxActions: number;
  maxActionsPerRow: number;
  maxRows?: number;
  maxLabelLength: number;
  supportsStyles: boolean;
  supportsDisabled: boolean;
  supportsLayoutHints: boolean;
  maxCallbackPayloadBytes: number;
};

export type MessagingTextEncoding = "utf8-bytes" | "utf16-units" | "characters";

export type MessagingMarkdownDialect =
  | "plain"
  | "html"
  | "slack-mrkdwn"
  | "discord-markdown"
  | "markdown";

export type MessagingTextCapabilities = {
  maxLength: number;
  encoding: MessagingTextEncoding;
  markdownDialect: MessagingMarkdownDialect;
  supportsCodeBlocks: boolean;
  supportsBold: boolean;
  supportsItalic: boolean;
  supportsLinks: boolean;
  supportsInlineCode: boolean;
  maxCaptionLength?: number;
  supportsMessageEdit: boolean;
};

export type MessagingAttachmentCapabilities = {
  maxAttachmentCount?: number;
  maxDownloadBytes?: number;
  supportsDownload: boolean;
};

export type MessagingOutboundAttachmentCapabilities = {
  maxUploadBytes?: number;
  supportsFileUpload: boolean;
  supportsImageUpload: boolean;
  supportsRemoteImageUrl: boolean;
};

export type MessagingCapabilityProfile = {
  actions: MessagingActionCapabilities | null;
  text: MessagingTextCapabilities;
  inboundAttachments?: MessagingAttachmentCapabilities;
  outboundAttachments?: MessagingOutboundAttachmentCapabilities;
};

export type MessagingCapabilitySurfaceKind =
  | "picker"
  | "status"
  | "approval"
  | "questionnaire"
  | "select"
  | "confirmation";

const CAPABILITY_MIN_ACTIONS: Record<MessagingCapabilitySurfaceKind, number> = {
  picker: 2,
  status: 3,
  approval: 2,
  questionnaire: 2,
  select: 2,
  confirmation: 2,
};

const DEFAULT_TEXT_MODE_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGE_SIZE = 8;

export function capabilityProfilePageSize(
  profile: MessagingCapabilityProfile,
  navActionCount: number,
  maxPageSize?: number,
): number {
  if (profile.actions === null) {
    return DEFAULT_TEXT_MODE_PAGE_SIZE;
  }
  const available = profile.actions.maxActions - navActionCount;
  const cap = maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
  return Math.max(1, Math.min(available, cap));
}

export function capabilityProfileMinActions(
  surfaceKind: MessagingCapabilitySurfaceKind,
): number {
  return CAPABILITY_MIN_ACTIONS[surfaceKind];
}

export function capabilityProfileSupportsActions(
  profile: MessagingCapabilityProfile,
  surfaceKind: MessagingCapabilitySurfaceKind,
): boolean {
  if (profile.actions === null) {
    return false;
  }
  return profile.actions.maxActions >= CAPABILITY_MIN_ACTIONS[surfaceKind];
}

export function truncateActionsByPriority(
  actions: MessagingSurfaceAction[],
  maxActions: number,
): MessagingSurfaceAction[] {
  if (actions.length <= maxActions) {
    return actions;
  }
  const sorted = [...actions].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) {
      return pa - pb;
    }
    return actions.indexOf(a) - actions.indexOf(b);
  });
  const kept = new Set(sorted.slice(0, maxActions));
  return actions.filter((action) => kept.has(action));
}

export const PERMISSIVE_CAPABILITY_PROFILE: MessagingCapabilityProfile = {
  actions: {
    maxActions: 100,
    maxActionsPerRow: 8,
    maxLabelLength: 256,
    supportsStyles: true,
    supportsDisabled: true,
    supportsLayoutHints: true,
    maxCallbackPayloadBytes: 256,
  },
  text: {
    maxLength: 16384,
    encoding: "characters",
    markdownDialect: "markdown",
    supportsCodeBlocks: true,
    supportsBold: true,
    supportsItalic: true,
    supportsLinks: true,
    supportsInlineCode: true,
    supportsMessageEdit: true,
  },
};

/** @deprecated Use MessagingCapabilityProfile instead. */
export type MessagingAdapterCapabilities = {
  inboundAttachments?: MessagingAttachmentCapabilities;
  outboundAttachments?: MessagingOutboundAttachmentCapabilities;
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
