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
import type { FederationTarget } from "./federation";
import type {
  NavigationLaunchpadFileAttachment,
  NavigationLaunchpadImageAttachment,
} from "./navigation";

export type ScheduledThreadActionKind = "turn" | "review";

export type ScheduledThreadActionStatus =
  | "held"
  | "scheduled"
  | "dispatching"
  | "queued"
  | "started"
  | "cancelled"
  | "failed";

export type ScheduledThreadActionOrigin = "desktop" | "messaging" | "agent";

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
};

export type ScheduledThreadReviewPayload = {
  target: AppServerReviewTarget;
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
  queueEntryId?: string;
  turnId?: string;
  errorMessage?: string;
  manualReleaseRequired?: boolean;
  createdAt: number;
  updatedAt: number;
};

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
