import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "./normalized-app-server";
import type {
  MessagingBindingTargetKind,
  MessagingChannelKind,
  MessagingConversationKind,
} from "./messaging";

export const PWRAGENT_MESSAGING_TOOL_NAMESPACE = "pwragent_messaging";

export const PWRAGENT_MESSAGING_OPERATION_NAMES = [
  "get_current_messaging_surface",
  "attach_thread_here",
] as const;

export type PwrAgentMessagingOperationName =
  (typeof PWRAGENT_MESSAGING_OPERATION_NAMES)[number];

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

export type PwrAgentMessagingBindingSummary = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  targetKind: MessagingBindingTargetKind;
  displayName?: string;
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
