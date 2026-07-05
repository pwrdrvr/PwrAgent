import type {
  AppServerBackendKind,
  MessagingDynamicToolCategory,
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
  ThreadIdentifier,
} from "@pwragent/shared";

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
  /** True when the tool may run. Non-messaging / legacy turns are always allowed. */
  allowed: boolean;
  /** The permission that was required (present when denied). */
  permission?: string;
};

export type MessagingAgentToolService = {
  handlePwrAgentMessagingRequest(
    request: PwrAgentMessagingRequest,
  ): Promise<PwrAgentMessagingResponse>;
  /**
   * Authorize an agent dynamic-tool call against the RBAC permissions of the
   * messaging actor who started the turn. Returns `{ allowed: true }` when the
   * turn is NOT messaging-originated (a desktop-operator turn) or when RBAC is
   * not enforcing — those keep full capability, exactly as before. Denials are
   * audited by the messaging layer.
   */
  checkDynamicToolPermission(
    check: DynamicToolPermissionCheck,
  ): DynamicToolPermissionResult;
};
