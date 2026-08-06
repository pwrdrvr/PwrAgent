import type {
  AppServerBackendKind,
  AppServerThreadTitleSource,
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
  "send_private_response",
  "attach_thread_here",
  "inspect_messaging_pdfs",
  "search_messaging_pdf_text",
  "render_messaging_pdf_pages",
] as const;

/**
 * Codex persists its initial tool configuration when a thread is created.
 * Version 2 records the dedicated PwrAgent loopback MCP surface that returns
 * rendered PDF pages as real MCP image content. Older threads use bounded
 * initial-image fallback because their dynamic tool catalog cannot be changed.
 */
export const PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION = 2;

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
  titleSource: AppServerThreadTitleSource;
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
  binding?: PwrAgentMessagingBindingSummary;
  channel: MessagingChannelKind;
  conversation: PwrAgentMessagingConversationSummary;
  managedConversation: PwrAgentMessagingManagedConversationSummary;
};

export type GetCurrentMessagingSurfaceToolArgs = Record<string, never>;

export type SendPrivateResponseToolArgs = {
  awaitReply?: boolean;
  replyInstructions?: string;
  text: string;
};

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

export type InspectMessagingPdfsToolArgs = Record<string, never>;

export type SearchMessagingPdfTextToolArgs = {
  attachmentId: string;
  pageEnd?: number;
  pageStart?: number;
  query: string;
};

export type RenderMessagingPdfPagesToolArgs = {
  attachmentId: string;
  pageNumbers: number[];
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

export type SendPrivateResponseResult = {
  awaitingReply?: boolean;
  channel: MessagingChannelKind;
  deliveredAt: number;
  outcome: "delivered";
  recipient: PwrAgentMessagingActorSummary;
};

export type PwrAgentMessagingPdfAttachmentSummary = {
  attachmentId: string;
  name: string;
  sizeBytes: number;
  pageCount: number;
  firstPage: {
    height: number;
    width: number;
    renderHeight: number;
    renderWidth: number;
  };
  renderLimits: {
    maxEncodedBytes: number;
    maxPageEncodedBytes: number;
    maxPages: number;
    maxPagePixels: number;
    maxPixels: number;
    maxWireBytes: number;
  };
};

export type PwrAgentMessagingPdfTextSearchResult = {
  attachmentId: string;
  matches: Array<{
    pageNumber: number;
    snippet: string;
  }>;
  pageEnd: number;
  pageStart: number;
  query: string;
  totalPageCount: number;
};

export type PwrAgentMessagingRenderedPdfPagesResult = {
  attachmentId: string;
  alreadySuppliedPageNumbers: number[];
  name: string;
  pages: Array<{
    height: number;
    pageNumber: number;
    width: number;
  }>;
};

export type PwrAgentMessagingToolImage = {
  base64: string;
  mimeType: string;
  pageNumber: number;
};

export type PwrAgentMessagingToolArgsByOperation = {
  get_current_messaging_surface: GetCurrentMessagingSurfaceToolArgs;
  get_current_location: GetCurrentMessagingSurfaceToolArgs;
  send_private_response: SendPrivateResponseToolArgs;
  attach_thread_here: AttachThreadHereToolArgs;
  inspect_messaging_pdfs: InspectMessagingPdfsToolArgs;
  search_messaging_pdf_text: SearchMessagingPdfTextToolArgs;
  render_messaging_pdf_pages: RenderMessagingPdfPagesToolArgs;
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
        | SendPrivateResponseResult
        | AttachThreadHereResult
        | {
            attachments: PwrAgentMessagingPdfAttachmentSummary[];
          }
        | PwrAgentMessagingPdfTextSearchResult
        | PwrAgentMessagingRenderedPdfPagesResult;
      imageContent?: PwrAgentMessagingToolImage[];
    }
  | {
      ok: false;
      error: {
        code: PwrAgentMessagingErrorCode;
        message: string;
      };
    };
