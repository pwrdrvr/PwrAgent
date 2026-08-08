import type {
  AppServerBackendKind,
  AppServerReviewDelivery,
  AppServerReviewTarget,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "./normalized-app-server";
import type { AppServerCollaborationModeRequest } from "./agent";
import type { FederationTarget } from "./federation";
import type {
  NavigationLaunchpadFileAttachment,
  NavigationLaunchpadImageAttachment,
} from "./navigation";

export type ScheduledThreadActionKind = "turn" | "review";

export type ScheduledThreadActionStatus =
  | "scheduled"
  | "dispatching"
  | "queued"
  | "started"
  | "cancelled"
  | "failed";

export type ScheduledThreadActionOrigin = "desktop" | "messaging" | "agent";

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
  /** Scheduler clock cursor for a subsequent terminalUpdatedAfter request. */
  observedAt?: number;
};

export type ScheduledThreadActionMutationResponse = {
  action: ScheduledThreadAction;
};
