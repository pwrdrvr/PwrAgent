import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { MessagingDynamicToolCategory } from "@pwragent/shared/contracts/rbac";
import type {
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
  PwrAgentMessagingContext,
} from "@pwragent/shared/contracts/messaging-tools";

/** A dynamic-tool call to authorize against the originating turn's RBAC actor. */
export type DynamicToolPermissionCheck = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
  category: MessagingDynamicToolCategory;
  tool: string;
  /**
   * The call's arguments, used for args-aware, per-field gating of
   * `mutate_thread` (model / reasoning / fast mode / rename / execution mode).
   * Ignored for every other tool.
   */
  arguments?: Record<string, unknown> | null;
};

export type DynamicToolPermissionResult = {
  /** True when the messaging policy allows this tool call. */
  allowed: boolean;
  /** The permission that was required (present when denied). */
  permission?: string;
  /** Lifecycle calls require enforcing RBAC even for admitted legacy actors. */
  rbacNotEnforced?: true;
};

export type MessagingAgentToolService = {
  authorizeRetainedTool?(
    context: PwrAgentMessagingContext,
    check: DynamicToolPermissionCheck,
  ): Promise<DynamicToolPermissionResult>;
  handlePwrAgentMessagingRequest(
    request: PwrAgentMessagingRequest,
  ): Promise<PwrAgentMessagingResponse>;
  /**
   * Authorize an agent dynamic-tool call against the RBAC permissions of the
   * messaging actor who started the turn. Returns `{ allowed: true }` when the
   * turn is NOT messaging-originated (a desktop-operator turn) or when RBAC is
   * not enforcing, except for tools that require explicit authorization.
   * Missing grants are audited by the messaging layer.
   */
  checkDynamicToolPermission(
    check: DynamicToolPermissionCheck,
  ): DynamicToolPermissionResult;
};
