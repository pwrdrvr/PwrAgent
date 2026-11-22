import { FULL_ACCESS_RISK_ACTION_PREFIX, type NewThreadOptionsSummary, type FullAccessRiskWarningContext, type FullAccessEscalationContext, type MessagingFullAccessControls, type FullAccessWarningResolution } from "./messaging-callback-helpers";
import { federationTargetForBinding, agentMessagingTurnKey } from "./messaging-backend-event-helpers";
import { containedMessagingBindingMatches } from "@pwragent/shared/contained-messaging";
import {
  permissionForDynamicTool,
  permissionsForThreadMutation,
  toolArgsTargetRemoteInstance,
} from "@pwragent/shared/contracts/rbac";
import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type {
  MessagingDynamicToolCategory,
  MessagingPermissionId,
  RbacResolution,
} from "@pwragent/shared/contracts/rbac";
import type { PwrAgentMessagingRequest } from "@pwragent/shared/contracts/messaging-tools";
import type { MessagingRequestSource } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingBrowseSessionRecord, MessagingConfirmationIntent, MessagingInboundEvent } from "@pwragent/messaging-interface";
import { MESSAGING_CALLBACK_HANDLE_TTL_MS } from "@pwragent/messaging-interface";
import { buildConfirmationIntent, buildErrorIntent } from "./messaging-renderer.js";
import { isPromiseLike, type FullAccessRiskPresentationMode } from "./messaging-inbound-helpers";
import type { MessagingAccessContext } from "./messaging-access-context";
import { normalizeMessagingFullAccessControls, fullAccessRiskPresentationForContext } from "./messaging-access-helpers";

export class MessagingAccessControl {
  private readonly authorizedActorIds: Set<string>;

  constructor(private readonly context: MessagingAccessContext, actorIds: readonly string[]) {
    this.authorizedActorIds = new Set(actorIds);
  }

  updateAuthorizedActorIds(actorIds: readonly string[]): void {
    this.authorizedActorIds.clear();
    for (const actorId of actorIds) {
      this.authorizedActorIds.add(actorId);
    }
  }

  monitorAuthorizedActorIds(event: MessagingInboundEvent): string[] {
    return this.authorizedActorIds.size > 0
      ? [...this.authorizedActorIds]
      : [event.actor.platformUserId];
  }

  async ensureFullAccessEscalationAllowed(
    context: FullAccessEscalationContext,
    event: MessagingInboundEvent,
  ): Promise<boolean> {
    // RBAC double-gate: escalating a thread to Codex Full Access requires the
    // dedicated danger permission IN ADDITION to the global Full Access
    // settings toggle below — the permission is never a bypass of the toggle.
    if (
      !(await this.requirePermission(
        event,
        "thread.execution.full_access",
        "execution:full-access",
      ))
    ) {
      return false;
    }
    const controls = await this.resolveFullAccessControls();
    if (!controls.allowEscalation) {
      await this.recordFullAccessPolicyViolation(context, event);
      await this.deliverFullAccessPolicyError(
        context.kind === "thread" ? context.binding : undefined,
        event,
        "Escalating to Full Access from messaging is disabled in Settings.",
      );
      return false;
    }

    const warning = await this.resolveFullAccessWarning(controls, event);
    if (!warning.shouldWarn) {
      return true;
    }

    await this.presentFullAccessRiskWarning(context, event);
    return false;
  }

  async presentFullAccessRiskWarning(
    context: FullAccessEscalationContext,
    event: MessagingInboundEvent,
    options: { presentationMode?: FullAccessRiskPresentationMode } = {},
  ): Promise<void> {
    const controls = await this.resolveFullAccessControls();
    const warning = await this.resolveFullAccessWarning(controls, event);
    const actionContext: FullAccessRiskWarningContext =
      context.kind === "thread"
        ? {
            kind: "thread",
            bindingId: context.binding?.id ?? "",
            threadId: context.threadId,
          }
        : context.kind === "new-thread"
          ? {
            kind: "new-thread",
            ...(options.presentationMode === "message"
              ? { pendingPrompt: true }
              : {}),
            sessionId: context.session.id,
          }
          : {
              backend: context.backend,
              ...(context.federatedThread?.target.scope === "remote"
                ? {
                    federationInstanceId:
                      context.federatedThread.target.instanceId,
                  }
                : {}),
              kind: "resume-thread",
              sessionId: context.session.id,
              threadId: context.threadId,
          };
    const presentation = fullAccessRiskPresentationForContext(
      context,
      options.presentationMode ?? "surface",
    );
    const actions: MessagingConfirmationIntent["actions"] = [
      {
        id: `${FULL_ACCESS_RISK_ACTION_PREFIX}accept`,
        label: "Yes",
        style: "primary",
        fallbackText: "yes",
        value: actionContext,
      },
      ...(warning.canDismiss
        ? [
            {
              id: `${FULL_ACCESS_RISK_ACTION_PREFIX}dismiss`,
              label: "Yes - and stop warning me",
              style: "primary" as const,
              fallbackText: "yes and stop warning me",
              value: actionContext,
            },
          ]
        : []),
      {
        id: `${FULL_ACCESS_RISK_ACTION_PREFIX}cancel`,
        label: "Cancel",
        style: "secondary",
        fallbackText: "cancel",
        value: actionContext,
      },
    ];
    const intent = buildConfirmationIntent({
      id: this.context.host().newIntentId("full-access-risk"),
      capabilityProfile: this.context.capabilityProfile,
      createdAt: this.context.now(),
      delivery: presentation.surface
        ? {
            mode: "update",
            replaceMarkup: true,
          }
        : undefined,
      title: "Enable Full Access?",
      body: [
        "Full Access allows network access and read/write access to almost all files on this machine.",
        "That means data can be exfiltrated unintentionally, or by malicious code the agent downloads and executes through a supply chain attack on npm, PyPI, Rust crates, Go modules, or a similar dependency source.",
      ].join("\n\n"),
      fallbackText: warning.canDismiss
        ? "Reply Yes, Yes - and stop warning me, or Cancel."
        : "Reply Yes or Cancel.",
      actions,
      targetSurface: presentation.surface,
    });
    const expiresAt =
      context.kind === "new-thread" || context.kind === "resume-thread"
        ? this.context.now() + MESSAGING_CALLBACK_HANDLE_TTL_MS
        : undefined;
    if (
      expiresAt !== undefined &&
      (context.kind === "new-thread" || context.kind === "resume-thread")
    ) {
      await this.context.store.upsertBrowseSession({
        ...context.session,
        expiresAt: Math.max(context.session.expiresAt, expiresAt),
        textInputExpiresAt:
          options.presentationMode === "message"
            ? this.context.now()
            : context.session.textInputExpiresAt ?? context.session.expiresAt,
        updatedAt: this.context.now(),
      });
    }
    const pending = await this.context.host().storePendingIntent(
      intent,
      presentation.binding,
      event,
      expiresAt === undefined ? undefined : { expiresAt },
    );
    const result = await this.context.host().deliver(intent, presentation.binding, event);
    if (result.surface) {
      await this.context.store.upsertPendingIntent({
        ...pending,
        surface: result.surface,
      });
    }
  }

  async canResumeFullAccessThreads(): Promise<boolean> {
    return (await this.resolveFullAccessControls()).allowThreadResume;
  }

  async resolveFullAccessRiskForSession(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    options: NewThreadOptionsSummary,
  ): Promise<"accepted" | "blocked" | "warning"> {
    if (session.fullAccessRiskAcceptedAt) {
      return "accepted";
    }
    const controls = await this.resolveFullAccessControls();
    if (!controls.allowEscalation) {
      await this.recordFullAccessPolicyViolation(
        { kind: "new-thread", session },
        event,
      );
      await this.deliverFullAccessPolicyError(
        undefined,
        event,
        "Starting a Full Access thread from messaging is disabled in Settings.",
      );
      return "blocked";
    }
    const warning = await this.resolveFullAccessWarning(controls, event);
    if (
      warning.policy === "dismissable" &&
      options.executionModeSource !== "session"
    ) {
      return "accepted";
    }
    return warning.shouldWarn ? "warning" : "accepted";
  }

  resolveFullAccessControls():
    | MessagingFullAccessControls
    | Promise<MessagingFullAccessControls> {
    const controls = this.context.config.fullAccessControls;
    const resolved =
      typeof controls === "function" ? controls() : controls;
    return isPromiseLike(resolved)
      ? Promise.resolve(resolved).then(normalizeMessagingFullAccessControls)
      : normalizeMessagingFullAccessControls(resolved);
  }

  async resolveFullAccessWarning(
    controls: MessagingFullAccessControls,
    event: MessagingInboundEvent,
  ): Promise<FullAccessWarningResolution> {
    const contact = controls.authorizedUsers?.[event.channel.channel]?.find(
      (candidate) => candidate.id === event.actor.platformUserId,
    );
    const policy = contact?.fullAccessWarningOverride ?? "default";
    const effectivePolicy =
      policy === "default" ? controls.warningPolicy : policy;
    if (effectivePolicy === "never") {
      return { canDismiss: false, policy: effectivePolicy, shouldWarn: false };
    }
    if (effectivePolicy === "always") {
      return { canDismiss: false, policy: effectivePolicy, shouldWarn: true };
    }
    const canPersistDismissal =
      controls.canDismissWarning
        ? await controls.canDismissWarning({
            actorId: event.actor.platformUserId,
            channel: event.channel.channel,
          })
        : Boolean(controls.dismissWarning);
    return {
      canDismiss: Boolean(controls.dismissWarning) && canPersistDismissal,
      policy: effectivePolicy,
      shouldWarn: contact?.fullAccessWarningDismissed !== true,
    };
  }

  async deliverFullAccessPolicyError(
    binding: MessagingBindingRecord | undefined,
    event: MessagingInboundEvent | undefined,
    body: string,
  ): Promise<void> {
    await this.context.host().deliver(
      buildErrorIntent({
        id: this.context.host().newIntentId("full-access-policy"),
        createdAt: this.context.now(),
        title: "Full Access blocked",
        body,
        recoverable: true,
      }),
      binding,
      event,
    );
  }

  async recordFullAccessPolicyViolation(
    context: FullAccessEscalationContext,
    event: MessagingInboundEvent,
  ): Promise<void> {
    try {
      await this.context.config.onFullAccessPolicyViolation?.({
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        backend:
          context.kind === "thread" || context.kind === "resume-thread"
            ? context.backend
            : undefined,
        bindingId: context.kind === "thread" ? context.binding?.id : undefined,
        channel: event.channel,
        requestedAction:
          context.kind === "thread"
            ? "messaging.full_access.escalate_thread"
            : context.kind === "resume-thread"
              ? "messaging.full_access.resume_with_escalation"
              : "messaging.full_access.start_new_thread",
        threadId:
          context.kind === "thread" || context.kind === "resume-thread"
            ? context.threadId
            : undefined,
      });
    } catch (error) {
      this.context.logger.debug?.("messaging full-access policy log failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  retainedRequestSource(context: PwrAgentMessagingRequest["context"]): MessagingRequestSource | undefined {
    if (context.causalMessagingAmbiguous) return undefined;
    if (context.causalMessagingSource) return this.context.config.requestStore?.get(context.causalMessagingSource);
    if (!context.turnId) return undefined;
    return this.context.host().activeAgentMessagingOriginsByTurnKey.get(
      agentMessagingTurnKey(context.backend, context.threadId, context.turnId),
    )?.source;
  }

  retainedRequestCanCrossInstance(context: PwrAgentMessagingRequest["context"], source: MessagingRequestSource): boolean {
    return !context.requestingInstanceId || this.actorHasPermission(source.event, "federation.remote_control");
  }

  async retainedSourceIsAuthorized(
    source: MessagingRequestSource,
    verifyAccess = true,
    localOnly = false,
  ): Promise<boolean | undefined> {
    if (!this.context.host().isChannelInScope(source.event.channel)
      || !source.connectionId || source.connectionId !== this.context.adapter.retainedSourceConnectionId?.()
      || !this.context.adapter.authorizeRetainedSource) return false;
    const providerAdmission = await this.context.adapter.authorizeRetainedSource(source.event, verifyAccess);
    if (providerAdmission !== true) return providerAdmission;
    if (source.bindingId) {
      const binding = await this.context.store.findActiveBindingForChannel(source.event.channel);
      if (!binding || binding.revokedAt || binding.backend !== source.agent.backend
        || binding.id !== source.bindingId || binding.threadId !== source.agent.threadId
        || (localOnly && binding.federatedThread)) return false;
    } else {
      if (await this.context.store.findActiveBindingForChannel(source.event.channel)) return false;
      // The effective default route, not any older broader matching assignment,
      // must still name the Agent that admitted this human request.
      const assignment = await this.context.store.findActiveDefaultAgentAssignmentForChannel(source.event.channel);
      if (!assignment || assignment.target.backend !== source.agent.backend
        || assignment.target.threadId !== source.agent.threadId) return false;
    }
    return true;
  }

  retainedSourceHasPermissions(source: MessagingRequestSource): boolean {
    const permissions = this.resolveActorPermissions(source.event);
    return permissions === null || (["thread.resume", "tools.thread_inspection"] as const)
      .every((permission) => permissions.permissions.has(permission));
  }

  async authorizeRetainedTool(
    context: PwrAgentMessagingRequest["context"],
    check: Parameters<MessagingAccessControl["checkDynamicToolPermission"]>[0],
  ): Promise<{ owns: boolean; allowed: boolean; permission?: string }> {
    const source = this.retainedRequestSource(context);
    if (!source || !this.context.host().isChannelInScope(source.event.channel)) return { owns: false, allowed: false };
    const permission = permissionForDynamicTool(check.category, check.tool);
    if (permission === "tools.messaging_profile_settings") {
      const active = () => context.turnId && this.context.host().activeAgentMessagingOriginsByTurnKey.get(
        agentMessagingTurnKey(context.backend, context.threadId, context.turnId),
      );
      const origin = active();
      if (!origin || origin.source?.ref.ownerId !== source.ref.ownerId
        || origin.source.ref.requestId !== source.ref.requestId || origin.binding?.federatedThread
        || !await this.retainedSourceIsAuthorized(source, true, true) || active() !== origin) {
        return { owns: true, allowed: false, permission };
      }
      return this.checkDynamicToolPermission(check, source);
    }
    if (context.containedPeer) {
      const binding = await this.context.store.findActiveBindingForChannel(source.event.channel);
      if (!source.bindingId || binding?.id !== source.bindingId || !containedMessagingBindingMatches(context, binding)) {
        return { owns: true, allowed: false, permission: "federation.remote_control" };
      }
    }
    if (!this.retainedRequestCanCrossInstance(context, source)) return { owns: true, allowed: false, permission: "federation.remote_control" };
    if (!await this.retainedSourceIsAuthorized(source, false)) return { owns: true, allowed: false, permission: "message.reply" };
    return this.checkDynamicToolPermission(check, source);
  }

  isAuthorized(platformUserId: string): boolean {
    return this.authorizedActorIds.has(platformUserId);
  }

  /**
   * Whether the actor allowlist still admits one of these actors. An empty
   * allowlist leaves admission to the provider's conversation allowlists.
   */
  admitsAnyActor(actorIds: readonly string[]): boolean {
    return this.authorizedActorIds.size === 0
      || actorIds.some((actorId) => this.authorizedActorIds.has(actorId));
  }

  // -------------------------------------------------------------------------
  // RBAC — capability layer (issue #260). Composes with, never replaces, the
  // provider admission gate. In legacy-compatible mode (no policy provider, or
  // enforcement disabled) every method here is a no-op so behavior is identical
  // to pre-RBAC PwrAgent.
  // -------------------------------------------------------------------------

  /**
   * Resolve the triggering actor's effective permissions, or `null` in
   * legacy-compatible mode (caller should treat null as "allow, Admin-implied").
   *
   * The admission-path inference: a caller in `authorizedActorIds` is a *named*
   * actor (only their named attachments apply); anyone else was admitted by the
   * provider through a bucket access mode (DM workspace bucket for direct
   * messages, channel bucket otherwise), so the matching bucket attachment
   * applies. See #260 §3.
   */
  resolveActorPermissions(
    event: MessagingInboundEvent,
  ): RbacResolution | null {
    const provider = this.context.config.rbacPolicy;
    if (!provider) {
      return null;
    }
    const actorId = event.actor.platformUserId;
    const named = this.authorizedActorIds.has(actorId);
    const admittedVia = named
      ? {}
      : event.channel.conversation.kind === "dm"
        ? { dmBucket: true }
        : { channelBucket: true };
    const input = {
      actorId,
      conversationId: event.channel.conversation.id,
      admittedVia,
    };
    // One policy read when the provider supports it — a gated action asks both
    // "are we enforcing?" and "what may they do?", and each ask re-reads.
    if (provider.resolveIfEnforcing) {
      return provider.resolveIfEnforcing(input);
    }
    return provider.isEnforcing() ? provider.resolve(input) : null;
  }

  /**
   * Admission gate replacement. Legacy mode preserves the exact
   * `authorizedActorIds` membership check. Enforcing mode admits any actor that
   * resolves to at least one permission-granting role (named or bucket) and
   * default-denies the rest.
   */
  authorizeInboundAdmission(event: MessagingInboundEvent): boolean {
    const resolution = this.resolveActorPermissions(event);
    if (resolution === null) {
      return this.isAuthorized(event.actor.platformUserId);
    }
    return !resolution.rejected;
  }

  /**
   * Gate a single action. Returns true (proceed) in legacy mode or when the
   * actor holds `permission`; otherwise records an audit row, optionally
   * notifies the user, and returns false. `notify: false` silently drops (used
   * for the plain-reply floor to avoid spamming a channel).
   */
  async requirePermission(
    event: MessagingInboundEvent,
    permission: MessagingPermissionId,
    auditAction: string,
    opts?: { notify?: boolean },
  ): Promise<boolean> {
    const resolution = this.resolveActorPermissions(event);
    if (resolution === null) {
      return true;
    }
    if (resolution.permissions.has(permission)) {
      return true;
    }
    this.recordCapabilityDenied(event, permission, resolution.roleIds, auditAction);
    if (opts?.notify !== false) {
      await this.deliverCapabilityDenied(event);
    }
    return false;
  }

  /**
   * Federation SCOPE gate. Every other permission answers "what may this actor
   * do"; this one answers "where". Required IN ADDITION to the action's own
   * permission whenever the thread being acted on lives on another instance —
   * the same double-gate shape as `thread.execution.full_access`, and for the
   * same reason: `thread.resume` on a peer's thread is a materially bigger
   * grant than on a local one, and `thread.execution.full_access` on a peer's
   * thread is full access on ANOTHER MACHINE.
   *
   * Local targets short-circuit to `true`, so this costs nothing for the
   * single-instance case. Legacy (unenforced) mode is allow-all as always.
   */
  async requireRemoteScope(
    event: MessagingInboundEvent,
    target: FederationTarget | undefined,
    auditAction: string,
    opts?: { notify?: boolean },
  ): Promise<boolean> {
    if (!target || target.scope !== "remote") {
      return true;
    }
    return await this.requirePermission(
      event,
      "federation.remote_control",
      auditAction,
      opts,
    );
  }

  /**
   * Non-auditing permission probe for render-time filtering. `requirePermission`
   * records a denial and messages the user, which is right when they ASKED to do
   * something and wrong when we're deciding what to put on a menu.
   */
  actorHasPermission(
    event: MessagingInboundEvent,
    permission: MessagingPermissionId,
  ): boolean {
    const resolution = this.resolveActorPermissions(event);
    return resolution === null || resolution.permissions.has(permission);
  }

  /**
   * Strip peers' threads from a snapshot before it reaches a picker. Enforcement
   * alone would still leak: the resume browser lists thread titles and projects,
   * so an actor without remote scope would read a peer's work before being told
   * they can't touch it. Filtering here keeps the menu honest — every row it
   * shows is a row the actor may actually bind.
   */
  /** `requireRemoteScope` for an already-resolved binding. */
  async requireRemoteScopeForBinding(
    event: MessagingInboundEvent,
    binding: MessagingBindingRecord | undefined,
    auditAction: string,
    opts?: { notify?: boolean },
  ): Promise<boolean> {
    if (!binding) return true;
    return await this.requireRemoteScope(
      event,
      federationTargetForBinding(binding),
      auditAction,
      opts,
    );
  }

  recordCapabilityDenied(
    event: MessagingInboundEvent,
    permission: MessagingPermissionId | "(admission)",
    roleIds: readonly string[],
    auditAction: string,
  ): void {
    try {
      const log = this.context.host().desktopActivityLog();
      if (!log) return;
      const conversation = event.channel.conversation;
      const who = event.actor.displayName ?? event.actor.platformUserId;
      log.record({
        platform: event.channel.channel,
        kind: "inbound-rejected",
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        summary: `Denied ${auditAction}: ${who} lacks ${permission}`,
        createdAt: this.context.now(),
        payload: {
          reason: "unauthorized-capability",
          permission,
          roleIds: [...roleIds],
          auditAction,
          conversationKind: conversation.kind,
        },
      });
    } catch {
      // Activity log is best-effort observability.
    }
  }

  async deliverCapabilityDenied(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.context.host().deliver(
      buildErrorIntent({
        id: this.context.host().newIntentId("capability-denied"),
        createdAt: this.context.now(),
        title: "Not permitted",
        body: "You don't have permission to do that.",
        recoverable: false,
      }),
      undefined,
      event,
    );
  }

  /**
   * Authorize an agent dynamic-tool call against the RBAC actor who started the
   * turn. `owns: false` means this controller has no record of the turn (a
   * different platform's controller, or a desktop-operator turn) — the runtime
   * asks each controller and only the owner decides. When owned: legacy mode is
   * allow-all; otherwise gate on the tool's required permission and audit
   * denials. This is the second RBAC surface — the agent reaching BEYOND the
   * bound thread — distinct from the actor's direct command/button surface.
   *
   * Known window: turn origins live only in this in-memory map. If a
   * controller is torn down mid-turn (messaging stop / adapter restart), a
   * still-running turn it started loses its origin, every controller answers
   * `owns: false`, and the runtime treats the turn as desktop-originated
   * (unrestricted). Accepted for Phase 1: teardown also severs the actor's
   * channel back to that turn, and persisting origins would couple RBAC to
   * turn-lifecycle storage. Revisit if turns ever survive controller restarts.
   */
  checkDynamicToolPermission(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    turnId?: string;
    category: MessagingDynamicToolCategory;
    tool: string;
    arguments?: Record<string, unknown> | null;
  }, source?: MessagingRequestSource): { owns: boolean; allowed: boolean; permission?: string } {
    if (!params.turnId && !source) {
      return { owns: false, allowed: true };
    }
    const origin = source ? { event: source.event } : this.context.host().activeAgentMessagingOriginsByTurnKey.get(
      agentMessagingTurnKey(params.backend, params.threadId, params.turnId!),
    );
    if (!origin) {
      return { owns: false, allowed: true };
    }
    const resolution = this.resolveActorPermissions(origin.event);
    if (resolution === null) {
      const explicitPermission = params.tool === "manage_pwragent"
        ? "tools.instance_lifecycle"
        : permissionForDynamicTool(params.category, params.tool);
      if (explicitPermission === "tools.instance_lifecycle" || explicitPermission === "tools.messaging_profile_settings") {
        return { owns: true, allowed: false, permission: explicitPermission };
      }
      // Legacy-compatible mode: full capability, exactly as before RBAC.
      return { owns: true, allowed: true };
    }
    // `mutate_thread` is gated PER FIELD (model/reasoning/fast/rename/execution
    // mode) at parity with the status buttons, including the Full Access danger
    // gate; every other tool needs a single category permission.
    const required =
      params.category === "thread_inspection" && params.tool === "mutate_thread"
        ? permissionsForThreadMutation(params.arguments)
        : ((): MessagingPermissionId[] => {
            const permission = permissionForDynamicTool(params.category, params.tool);
            return permission ? [permission] : [];
          })();
    // Scope: the thread tools accept `instanceId` / `includeRemote`, so the
    // agent can aim them at a peer. Reaching another instance needs the scope
    // permission on top of the tool's own — and it applies even to otherwise
    // ungated tools, because "benign here" is not benign on someone else's
    // machine.
    if (toolArgsTargetRemoteInstance(params.arguments)) {
      required.push("federation.remote_control");
    }
    if (params.tool === "manage_pwragent") required.push("tools.instance_lifecycle");
    if (required.length === 0) {
      // Benign tool (e.g. get_current_messaging_surface, or a no-op mutation).
      return { owns: true, allowed: true };
    }
    const missing = required.find(
      (permission) => !resolution.permissions.has(permission),
    );
    if (!missing) {
      return { owns: true, allowed: true };
    }
    this.recordCapabilityDenied(
      origin.event,
      missing,
      resolution.roleIds,
      `tool:${params.category}:${params.tool}`,
    );
    return { owns: true, allowed: false, permission: missing };
  }
}
