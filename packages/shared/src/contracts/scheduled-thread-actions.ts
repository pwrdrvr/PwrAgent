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
  scheduledFor?: number;
  displayText?: string;
  imageAttachments?: NavigationLaunchpadImageAttachment[];
  fileAttachments?: NavigationLaunchpadFileAttachment[];
  turn?: ScheduledThreadTurnPayload;
  review?: ScheduledThreadReviewPayload;
};

export type ScheduledThreadActionIdRequest = {
  id: string;
};

export type ListScheduledThreadActionsRequest = {
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  includeTerminal?: boolean;
};

export type ListScheduledThreadActionsResponse = {
  actions: ScheduledThreadAction[];
};

export type ScheduledThreadActionMutationResponse = {
  action: ScheduledThreadAction;
};
