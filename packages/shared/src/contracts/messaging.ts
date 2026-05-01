import type {
  AppServerBackendKind,
  AppServerThreadImagePart,
  AppServerThreadMessagePart,
  AppServerThreadSummary,
  ThreadIdentifier,
  ThreadExecutionMode,
} from "./normalized-app-server";
import type {
  NavigationDirectorySummary,
  NavigationSnapshot,
  NavigationThreadSummary,
} from "./navigation";

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

export type MessagingSurfaceIntentKind =
  (typeof MESSAGING_SURFACE_INTENT_KINDS)[number];
export type MessagingInboundEventKind =
  (typeof MESSAGING_INBOUND_EVENT_KINDS)[number];
export type MessagingDeliveryOutcome =
  (typeof MESSAGING_DELIVERY_OUTCOMES)[number];

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

export type MessagingSurfaceAction = {
  id: string;
  label: string;
  description?: string;
  style?: MessagingActionStyle;
  value?: MessagingJsonValue;
  disabled?: boolean;
  fallbackText?: string;
};

export type MessagingChoice = MessagingSurfaceAction & {
  recommended?: boolean;
};

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

export type MessagingBaseSurfaceIntent = {
  id: string;
  kind: MessagingSurfaceIntentKind;
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
  updatedAt: number;
};

export type MessagingActiveTurnSummary = {
  turnId: string;
  status: "working" | "waiting" | "completed" | "failed" | "interrupted";
  startedAt?: number;
  updatedAt: number;
};

export type MessagingThreadDisplaySummary = {
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
