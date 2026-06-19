import type {
  AppServerBackendKind,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "./normalized-app-server";
import type {
  MessagingBindingTargetKind,
  MessagingChannelKind,
  MessagingConversationKind,
} from "./messaging";

/** @deprecated Use PWRAGENT_TOOL_NAMESPACE for advertised dynamic tools. */
export const PWRAGENT_MESSAGING_TOOL_NAMESPACE = "pwragent_messaging";

export const PWRAGENT_MESSAGING_OPERATION_NAMES = [
  "get_current_messaging_surface",
  "attach_thread_here",
] as const;

export const PWRAGENT_MESSAGING_LEGACY_OPERATION_NAMES = [
  "get_current_location",
] as const;

export const PWRAGENT_MESSAGING_CALLABLE_OPERATION_NAMES = [
  ...PWRAGENT_MESSAGING_OPERATION_NAMES,
  ...PWRAGENT_MESSAGING_LEGACY_OPERATION_NAMES,
] as const;

export type PwrAgentMessagingAdvertisedOperationName =
  (typeof PWRAGENT_MESSAGING_OPERATION_NAMES)[number];

export type PwrAgentMessagingLegacyOperationName =
  (typeof PWRAGENT_MESSAGING_LEGACY_OPERATION_NAMES)[number];

export type PwrAgentMessagingOperationName =
  (typeof PWRAGENT_MESSAGING_CALLABLE_OPERATION_NAMES)[number];

export const PWRAGENT_MESSAGING_ERROR_CODES = [
  "invalid_arguments",
  "not_found",
  "ambiguous_location",
  "forbidden",
  "unsupported_operation",
  "internal_error",
] as const;

export type PwrAgentMessagingErrorCode =
  (typeof PWRAGENT_MESSAGING_ERROR_CODES)[number];

export type PwrAgentMessagingContext = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
};

export type PwrAgentMessagingConversationSummary = {
  id: string;
  kind: MessagingConversationKind;
  parentId?: string;
  title?: string;
  parentTitle?: string;
  ancestorTitle?: string;
};

export type PwrAgentMessagingActorSummary = {
  platformUserId: string;
  displayName?: string;
  username?: string;
  isBot?: boolean;
};

export type PwrAgentMessagingBoundThreadSummary = {
  title: string;
  projectKey?: string;
  gitBranch?: string;
  model?: string;
  executionMode?: ThreadExecutionMode;
  agentName?: string;
};

export type PwrAgentMessagingBindingSummary = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  targetKind: MessagingBindingTargetKind;
  displayName?: string;
  thread?: PwrAgentMessagingBoundThreadSummary;
};

export type PwrAgentMessagingManagedConversationOperationSummary = {
  operation: "create_child" | "close" | "reopen" | "delete";
  supported: boolean;
  missingPermission?: string;
  reason?: string;
};

export type PwrAgentMessagingManagedConversationSummary = {
  canCreateChild: boolean;
  operation?: PwrAgentMessagingManagedConversationOperationSummary;
  operations: PwrAgentMessagingManagedConversationOperationSummary[];
  outcome: "ok" | "unsupported" | "failed";
  errorMessage?: string;
  providerSupportsCreation: boolean;
  updatedAt?: number;
};

export type PwrAgentMessagingLocationSummary = {
  actor?: PwrAgentMessagingActorSummary;
  binding: PwrAgentMessagingBindingSummary;
  channel: MessagingChannelKind;
  conversation: PwrAgentMessagingConversationSummary;
  managedConversation: PwrAgentMessagingManagedConversationSummary;
};

export type GetCurrentMessagingSurfaceToolArgs = Record<string, never>;

export type AttachThreadHerePlacement =
  | "auto"
  | "new_child"
  | "current_conversation";

export type AttachThreadHereToolArgs = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  placement?: AttachThreadHerePlacement;
  targetKind?: MessagingBindingTargetKind;
  title?: string;
};

export type AttachThreadHereResult = {
  binding: PwrAgentMessagingBindingSummary;
  channel: MessagingChannelKind;
  conversation: PwrAgentMessagingConversationSummary;
  createdConversation?: PwrAgentMessagingConversationSummary;
  location: PwrAgentMessagingLocationSummary;
  outcome: "attached" | "created_and_attached";
  placement: Exclude<AttachThreadHerePlacement, "auto">;
};

export type PwrAgentMessagingToolArgsByOperation = {
  get_current_messaging_surface: GetCurrentMessagingSurfaceToolArgs;
  get_current_location: GetCurrentMessagingSurfaceToolArgs;
  attach_thread_here: AttachThreadHereToolArgs;
};

export type PwrAgentMessagingToolArgs<
  TOperation extends PwrAgentMessagingOperationName =
    PwrAgentMessagingOperationName,
> = PwrAgentMessagingToolArgsByOperation[TOperation];

export type PwrAgentMessagingRequest<
  TOperation extends PwrAgentMessagingOperationName =
    PwrAgentMessagingOperationName,
> = {
  [TOperationKey in TOperation]: {
    operation: TOperationKey;
    context: PwrAgentMessagingContext;
    args: PwrAgentMessagingToolArgs<TOperationKey>;
  };
}[TOperation];

export type PwrAgentMessagingResponse =
  | {
      ok: true;
      data:
        | {
            location: PwrAgentMessagingLocationSummary;
          }
        | AttachThreadHereResult;
    }
  | {
      ok: false;
      error: {
        code: PwrAgentMessagingErrorCode;
        message: string;
      };
    };
