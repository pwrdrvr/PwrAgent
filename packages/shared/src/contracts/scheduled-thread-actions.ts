import type {
  AppServerBackendKind,
  AppServerReviewDelivery,
  AppServerReviewTarget,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "./normalized-app-server";
import type {
  AppServerCollaborationModeRequest,
  ReviewAfterAction,
  ReviewRunMode,
} from "./agent";
import type { FederationRemoteTarget, FederationTarget } from "./federation";
import type {
  NavigationLaunchpadFileAttachment,
  NavigationLaunchpadImageAttachment,
} from "./navigation";

/**
 * `notification` is an agent's `notify_operator` notice. It starts no turn:
 * the scheduler delivers it to the operator when it comes due.
 */
export type ScheduledThreadActionKind = "turn" | "review" | "notification";

export type ScheduledThreadActionStatus =
  | "held"
  | "scheduled"
  | "dispatching"
  | "queued"
  | "started"
  | "cancelled"
  | "failed";

export type ScheduledThreadActionOrigin = "desktop" | "messaging" | "agent";
export type SteerFallbackInputSource = "desktop" | "federation";

/** Agent follow-ups a thread may hold that have not started or ended. */
export const AGENT_FOLLOW_UP_MAX_ACTIVE_PER_THREAD = 8;
/** The soonest an agent may ask to be woken. */
export const AGENT_FOLLOW_UP_MIN_DELAY_MS = 60_000;
/** The furthest ahead an agent may ask to be woken. */
export const AGENT_FOLLOW_UP_MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
/** Agent follow-ups one thread may fire in a rolling window before suspension. */
export const AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW = 12;
export const AGENT_FOLLOW_UP_FIRED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AGENT_FOLLOW_UP_PROMPT_MAX_CHARS = 8000;

/**
 * A thread's loop guard for agent follow-ups. A trip stays until the local
 * operator rearms it; neither the window expiring nor a restart clears it.
 */
export type AgentFollowUpProtection = {
  firedInWindow: number;
  suspendedAt?: number;
};

/** `schedule_follow_up` input. The calling thread is never an argument. */
export type ScheduleFollowUpToolArgs = {
  action: "create" | "list" | "cancel";
  /** Create: minutes from now. Give this or `at`. */
  delayMinutes?: number;
  /** Create: an ISO 8601 time. */
  at?: string;
  /** Create: what the woken turn should do, written to stand alone. */
  prompt?: string;
  /** Cancel: an id from create or list. */
  followUpId?: string;
};

export type AgentFollowUpSummary = {
  followUpId: string;
  kind: ScheduledThreadActionKind;
  status: ScheduledThreadActionStatus;
  /** ISO 8601. */
  scheduledFor: string;
  /** Who set it. Only `agent` rows can be cancelled with this tool. */
  setBy: "agent" | "operator" | "messaging";
  cancellable: boolean;
  /** Cut to 600 characters. */
  prompt: string;
};

export type ScheduleFollowUpToolResult = {
  /** The follow-up a create or cancel acted on. */
  followUp?: AgentFollowUpSummary;
  /** List: every scheduled action waiting on this thread, soonest first. */
  followUps?: AgentFollowUpSummary[];
  activeAgentFollowUps: number;
  limits: {
    maxActive: number;
    minDelayMinutes: number;
    maxFiredPerDay: number;
  };
  firedInLastDay: number;
  /** Loop protection tripped. Nothing fires until the operator rearms it. */
  suspended?: true;
  notice?: string;
};

/** How loudly a notice asks for attention. `high` takes the warning tone. */
export type AgentNotificationUrgency = "normal" | "high";

/**
 * What the notice's primary action opens besides its thread: an `http(s)`
 * page, or a local file of a type PwrAgent's file viewer can preview.
 */
export type AgentNotificationLink =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string };

export const AGENT_NOTIFICATION_TITLE_MAX_CHARS = 120;
export const AGENT_NOTIFICATION_BODY_MAX_CHARS = 600;
/** The furthest ahead a notice may be scheduled, as for follow-ups. */
export const AGENT_NOTIFICATION_MAX_DELAY_MS = AGENT_FOLLOW_UP_MAX_DELAY_MS;

export type ScheduledThreadNotificationPayload = {
  title: string;
  body: string;
  urgency: AgentNotificationUrgency;
  link?: AgentNotificationLink;
};

/**
 * Operator bounds on `notify_operator`. Zero turns a bound off. The rolling
 * windows count every notice an agent created, including cancelled ones, so
 * cancelling and re-creating cannot spend more than the bound.
 */
export type AgentNotificationLimits = {
  maxPerThreadPerDay: number;
  maxPerProfilePerDay: number;
  maxScheduledPerThread: number;
};

export const AGENT_NOTIFICATION_LIMITS_DEFAULT: AgentNotificationLimits = {
  maxPerThreadPerDay: 12,
  maxPerProfilePerDay: 60,
  maxScheduledPerThread: 8,
};
export const AGENT_NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `notify_operator` input. The calling thread is never an argument. */
export type NotifyOperatorToolArgs = {
  action: "send" | "list" | "cancel";
  /** Send: a short headline. */
  title?: string;
  /** Send: one or two sentences the operator can act on without the thread. */
  body?: string;
  urgency?: AgentNotificationUrgency;
  /** Send: deliver this many minutes from now instead of now. */
  delayMinutes?: number;
  /** Send: deliver at this ISO 8601 time with an offset instead of now. */
  at?: string;
  /** Send: an `http(s)` URL the notice opens. */
  url?: string;
  /** Send: an absolute path to a file PwrAgent's file viewer can preview. */
  filePath?: string;
  /** Cancel: an id from send or list. */
  notificationId?: string;
};

export type AgentNotificationSummary = {
  notificationId: string;
  status: ScheduledThreadActionStatus;
  /** ISO 8601. When it was, or will be, delivered. */
  scheduledFor: string;
  title: string;
  urgency: AgentNotificationUrgency;
  cancellable: boolean;
};

export type NotifyOperatorToolResult = {
  notification?: AgentNotificationSummary;
  /** List: this thread's notices waiting or delivered in the last day. */
  notifications?: AgentNotificationSummary[];
  limits: AgentNotificationLimits;
  sentInLastDay: number;
};

/** One agent notice, as the operator's windows show it. */
export type AgentNotificationItem = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  title: string;
  body: string;
  urgency: AgentNotificationUrgency;
  link?: AgentNotificationLink;
  status: ScheduledThreadActionStatus;
  scheduledFor: number;
  /** When it was delivered; absent while it waits. */
  deliveredAt?: number;
  /** The thread's title on its owner, when the owner sent it. */
  threadTitle?: string;
  /**
   * The peer that owns it. The viewer adds this to a peer's notices; an
   * owner never sends it.
   */
  federationTarget?: FederationRemoteTarget;
  /** The owner's name, for a peer's notices. */
  ownerLabel?: string;
};

/**
 * The owner's notices for its windows. `unread` are delivered and not yet
 * dismissed in this process; `scheduled` wait; `earlier` were delivered in
 * the last day, read from the scheduler, so they survive a restart.
 */
export type AgentNotificationsSnapshot = {
  unread: AgentNotificationItem[];
  scheduled: AgentNotificationItem[];
  earlier: AgentNotificationItem[];
};

/**
 * What a window asks of the notices it shows. A dismiss or cancel names the
 * peer that owns the notice; without one it is this machine's.
 */
export type ManageAgentNotificationsRequest =
  | { action: "snapshot" }
  | { action: "dismiss"; id: string; federationTarget?: FederationRemoteTarget }
  | { action: "dismiss_all" }
  | { action: "cancel"; id: string; federationTarget?: FederationRemoteTarget };

export type ManageAgentNotificationsResponse =
  | { ok: true; snapshot: AgentNotificationsSnapshot }
  | { ok: false; error: { code: "unavailable" | "not_found" | "invalid_request"; message: string } };

export type ScheduledThreadTurnPayload = {
  input: AppServerTurnInputItem[];
  executionMode?: ThreadExecutionMode;
  approvalPolicy?: string;
  sandbox?: string;
  model?: string;
  collaborationMode?: AppServerCollaborationModeRequest;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  messageOrigin?: AppServerThreadMessageOrigin;
  /** Set by the owner when a live composer send has to wait for a new turn. */
  steerFallbackInputSource?: SteerFallbackInputSource;
};

export type ScheduledThreadReviewPayload = {
  target: AppServerReviewTarget;
  /** An operator's review card, completed by the owner when this review starts. */
  todo?: { id: string; allowOpenItems?: boolean };
  draftText?: string;
  delivery?: AppServerReviewDelivery;
  runMode?: ReviewRunMode;
  /** What follows the review once it runs; see `StartReviewRequest.afterReview`. */
  afterReview?: ReviewAfterAction;
  cwd?: string;
  /**
   * Reviewer override captured when the review was queued, so releasing it
   * later runs on the picked provider instead of silently falling back to the
   * thread's own.
   */
  reviewBackend?: AppServerBackendKind;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
};

export type ScheduledThreadAction = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  kind: ScheduledThreadActionKind;
  origin: ScheduledThreadActionOrigin;
  status: ScheduledThreadActionStatus;
  scheduledFor: number;
  displayText: string;
  imageAttachments?: NavigationLaunchpadImageAttachment[];
  fileAttachments?: NavigationLaunchpadFileAttachment[];
  turn?: ScheduledThreadTurnPayload;
  review?: ScheduledThreadReviewPayload;
  notification?: ScheduledThreadNotificationPayload;
  queueEntryId?: string;
  turnId?: string;
  errorMessage?: string;
  manualReleaseRequired?: boolean;
  /**
   * Why a held action waits, when the queue that held it said so. A thread
   * lock's hold lives in its holder's memory, and a later launch admits it
   * again once that holder is gone. Rows from older builds have none; their
   * `errorMessage` is the refusal text instead.
   */
  holdCause?: ScheduledThreadActionHoldCause;
  createdAt: number;
  updatedAt: number;
};

export type ScheduledThreadActionHoldCause = "thread_lock";

export type CreateScheduledThreadActionRequest = {
  backend: AppServerBackendKind;
  federationTarget?: FederationTarget;
  threadId: ThreadIdentifier;
  kind: ScheduledThreadActionKind;
  origin?: ScheduledThreadActionOrigin;
  scheduledFor: number;
  displayText: string;
  manualReleaseRequired?: boolean;
  imageAttachments?: NavigationLaunchpadImageAttachment[];
  fileAttachments?: NavigationLaunchpadFileAttachment[];
  turn?: ScheduledThreadTurnPayload;
  review?: ScheduledThreadReviewPayload;
};

export type UpdateScheduledThreadActionRequest = {
  id: string;
  federationTarget?: FederationTarget;
  scheduledFor?: number;
  displayText?: string;
  imageAttachments?: NavigationLaunchpadImageAttachment[];
  fileAttachments?: NavigationLaunchpadFileAttachment[];
  turn?: ScheduledThreadTurnPayload;
  review?: ScheduledThreadReviewPayload;
};

export type ScheduledThreadActionIdRequest = {
  id: string;
  federationTarget?: FederationTarget;
};

export type ListScheduledThreadActionsRequest = {
  /** Complete renderer projections use bounded pages, never the legacy list. */
  projectionProtocol?: 2;
  /** Original bounded projection transaction deadline, preserved across pages and relays. */
  deadlineAt?: number;
  cursor?: string;
  backend?: AppServerBackendKind;
  federationTarget?: FederationTarget;
  threadId?: ThreadIdentifier;
  includeTerminal?: boolean;
  /** Include retained failed actions alongside all active actions. */
  includeFailed?: boolean;
  /** Include terminal actions changed at or after this timestamp alongside all active actions. */
  terminalUpdatedAfter?: number;
};

export type ListScheduledThreadActionsResponse = {
  actions: ScheduledThreadAction[];
  projectionProtocol?: 2;
  revision?: string;
  complete?: boolean;
  nextCursor?: string;
  /** Scheduler clock cursor for a subsequent terminalUpdatedAfter request. */
  observedAt?: number;
};

export type ScheduledThreadActionMutationResponse = {
  action: ScheduledThreadAction;
};
