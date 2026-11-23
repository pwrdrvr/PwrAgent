import { federationRefsMatch } from "./messaging-callback-helpers";
import { bindingMatchesFederationTarget, federationTargetForBinding } from "./messaging-backend-event-helpers";
import { randomUUID } from "node:crypto";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { federatedThreadIdentityKey } from "@pwragent/shared/contracts/federation";
import { normalizeRenamedTitleSource } from "@pwragent/shared/contracts/normalized-app-server";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerBackendKind,
  HandoffThreadWorkspaceResponse,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { FederatedThreadRef, FederationTarget } from "@pwragent/shared/contracts/federation";
import type {
  MessagingBindingTargetKind,
  MessagingToolUpdateMode,
} from "@pwragent/shared/contracts/messaging";
import type { ThreadMessagingBindingTransition } from "@pwragent/shared/contracts/navigation";
import type { MessagingBindingRecord, MessagingChannelRef, MessagingInboundEvent, MessagingAdapterState, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { buildMessagingConversationKey } from "./messaging-store.js";
import { buildActivityIntent, buildConfirmationIntent, buildErrorIntent } from "./messaging-renderer.js";
import { PerKeyAsyncLock } from "../../util/per-key-async-lock.js";
import { buildBindingStatusIntent } from "./messaging-status-card.js";
import { resolveMessagingThreadState, type MessagingNavigationContext, type MessagingThreadContext } from "./messaging-thread-state.js";
import { threadContextForAdmissionState, normalizeConversationTitle, conversationKindLabel, isDefaultAgentRouteBinding, handoffContextForBinding, describeConversation, mergeRetiredBindingStatus } from "./messaging-binding-helpers";
import type { MessagingBindingContext } from "./messaging-binding-context";

export class MessagingBindingService {
  constructor(private readonly context: MessagingBindingContext) {}

  private readonly statusRenderLock = new PerKeyAsyncLock();

  /**
   * Self-heal stored bindings from the freshest data on every inbound.
   * The adapter populates `parentTitle` / `ancestorTitle` (supergroup
   * / server / channel breadcrumbs) on every inbound channel ref;
   * legacy bindings stored before those fields existed don't have
   * them. Merge in any new fields the binding doesn't already have so
   * the navigation snapshot's binding chip can render full
   * breadcrumbs without waiting for an explicit unbind/rebind.
   */
  async refreshBindingFromInbound(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.refreshBindingChannelMetadata(
      event.channel,
      event.routingState,
      event.receivedAt,
    );
  }

  async refreshBindingChannelMetadata(
    channel: MessagingChannelRef,
    routingStateUpdate?: MessagingAdapterState,
    observedAt = this.context.now(),
  ): Promise<void> {
    const binding = await this.context.store.findActiveBindingForChannel(
      channel,
    );
    if (!binding) return;
    const incoming = channel.conversation;
    // Incoming wins when present. Adapters fetch fresher metadata
    // than we stored at bind time:
    //   - Discord publishes channel/parent/guild names through the
    //     post-dispatch metadata hook after bounded-LRU REST enrichment,
    //     so a server or channel rename reaches us without delaying admission.
    //   - Telegram caches forum-topic names from `forum_topic_created`
    //     and `forum_topic_edited` service messages, so renames done
    //     in the Telegram client propagate to subsequent inbound
    //     messages.
    // When `incoming` doesn't carry a field (e.g. a regular Telegram
    // topic message that doesn't ship the topic name and the cache
    // missed), the store merge keeps the current value so we never
    // lose data we already have. The read/compare/write is one store
    // transaction: this off-path task cannot restore a binding that
    // routing revoked or overwrite a newer preference update.
    //
    // Loop safety: the store's `changed` guard means an inbound
    // whose values match what's stored produces no write and no
    // broadcast — so the gateway echo of our own `editForumTopic`
    // call (which carries the same name we just wrote in
    // `syncConversationName`) is a no-op, not a refresh storm.
    const managedTopic =
      incoming.kind === "topic" && incoming.parentId
        ? await this.context.store.findManagedTopicByConversation({
            channel: channel.channel,
            supergroupId: incoming.parentId,
            topicId: incoming.id,
          })
        : undefined;
    const managedConversation = managedTopic?.conversation;
    // Root-conversation fallback lookup can resolve a DM binding from a
    // thread-shaped Agent Session event. Passing `binding.channel` keeps the
    // merge's identity guard satisfied so those fresher titles land — but it
    // also makes that guard a self-comparison, so the caller has to decide
    // for itself whether this event describes the binding's own
    // conversation. Routing state is the part that must not cross over:
    // adopting a thread's `threadTs` here would silently re-anchor every
    // later status card, reply, and working card into that thread.
    const describesSameConversation =
      buildMessagingConversationKey(binding.channel)
      === buildMessagingConversationKey(channel);
    const merged = await this.context.store.mergeBindingChannelMetadata({
      ancestorTitle: incoming.ancestorTitle ?? managedConversation?.ancestorTitle,
      bindingId: binding.id,
      channel: binding.channel,
      observedAt,
      parentTitle: incoming.parentTitle ?? managedConversation?.parentTitle,
      routingState: describesSameConversation ? routingStateUpdate : undefined,
      title: incoming.title ?? managedConversation?.title,
    });
    if (!merged?.changed) return;
    // The chip now has fresher breadcrumbs in the store; nudge the
    // renderer to refetch so the tooltip / label reflect them.
    this.notifyBindingChanged("refresh-from-inbound");
  }

  /**
   * Re-render status surfaces for every binding tied to a thread on this
   * controller's channel. Used by the thread-state update bus to fan out
   * cross-surface refreshes when state changes anywhere — desktop UI,
   * Telegram callback, Discord callback — so every surface reflects the new
   * value. The reason is logged for audit only.
   */
  async refreshStatusSurfacesForThread(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    reason: string,
    federationTarget?: FederationTarget,
  ): Promise<void> {
    const bindings = this.context.host().filterBindingsForChannel(
      await this.context.store.findActiveBindingsForThread({
        backend,
        threadId,
      }),
    ).filter((binding) =>
      bindingMatchesFederationTarget(binding, federationTarget)
    );
    const renderableBindings = bindings.filter(
      (binding) => binding.statusSurface || binding.pinnedStatusSurface,
    );
    if (renderableBindings.length === 0) {
      return;
    }
    // Resolve one targeted thread projection and reuse it across every
    // binding. Thread-state bus fan-out must not rebuild unrelated navigation,
    // Git, PR, launchpad, or federation state just to repaint a status card.
    const admissionState = await this.context.backend.getThreadAdmissionState({
      backend,
      ...(federationTarget ? { federationTarget } : {}),
      threadId,
    });
    const navigation = threadContextForAdmissionState(
      renderableBindings[0]!,
      admissionState,
    );
    for (const binding of renderableBindings) {
      try {
        await this.renderBindingStatus(binding, undefined, navigation);
      } catch (error) {
        this.context.logger.debug?.("messaging status refresh failed", {
          backend,
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          reason,
          threadId,
        });
      }
    }
  }

  async clearActiveBindingSubmodeIntent(
    event: MessagingInboundEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    while (true) {
      const pendingIntent =
        await this.context.store.findActivePendingIntentForChannel({
          actorId: event.actor.platformUserId,
          channel: event.channel,
          now: this.context.now(),
        });
      if (
        !pendingIntent ||
        pendingIntent.bindingId !== binding.id ||
        pendingIntent.intent.requestContext
      ) {
        return;
      }
      await this.context.store.deletePendingIntent(pendingIntent.id);
    }
  }

  private async hasActiveBindingSubmodeIntent(
    binding: MessagingBindingRecord,
  ): Promise<boolean> {
    const statusSurface = binding.statusSurface ?? binding.pinnedStatusSurface;
    if (!statusSurface) {
      return false;
    }
    for (const actorId of binding.authorizedActorIds) {
      const pendingIntent =
        await this.context.store.findActivePendingIntentForChannel({
          actorId,
          channel: binding.channel,
          now: this.context.now(),
        });
      if (
        pendingIntent?.bindingId === binding.id &&
        !pendingIntent.intent.requestContext &&
        pendingIntent.surface?.channel === statusSurface.channel &&
        pendingIntent.surface.id === statusSurface.id
      ) {
        return true;
      }
    }
    return false;
  }

  async updateBindingAfterHandoff(
    binding: MessagingBindingRecord,
    _result: HandoffThreadWorkspaceResponse,
  ): Promise<MessagingBindingRecord> {
    // Live navigation now owns status display metadata; keep the binding current
    // without restoring legacy threadDisplay cache fields that the store strips.
    return await this.context.store.upsertBinding({
      ...binding,
      updatedAt: this.context.now(),
    });
  }

  async deliverAndStoreStatusSubmode(
    intent: MessagingSurfaceIntent,
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const activeIntent = await this.context.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.context.now(),
    });
    if (
      activeIntent &&
      activeIntent.id !== intent.id &&
      activeIntent.bindingId === binding.id &&
      !activeIntent.intent.requestContext
    ) {
      await this.context.store.deletePendingIntent(activeIntent.id);
    }
    const pendingIntent = await this.context.host().storePendingIntent(intent, binding, event);
    const result = await this.context.host().deliver(intent, binding, event);
    if (!result.surface) {
      return;
    }
    await this.context.store.upsertPendingIntent({
      ...pendingIntent,
      surface: result.surface,
    });
    await this.context.store.upsertBinding({
      ...binding,
      statusSurface: result.surface,
      updatedAt: this.context.now(),
    });
  }

  async syncConversationName(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const target = this.conversationTitleTarget(binding, event);
    if (
      !this.context.adapter.setConversationTitle
      || this.context.adapter.supportsConversationTitle?.(target) === false
    ) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("status-sync-name-unavailable"),
          createdAt: this.context.now(),
          title: "Name sync unavailable",
          body: `This ${conversationKindLabel(binding.channel.conversation.kind)} cannot be renamed from messaging.`,
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const navigation: MessagingThreadContext = { kind: "thread", thread: await this.context.host().readBoundNavigationThread(binding) };
    const threadState = resolveMessagingThreadState({
      activeTurn: this.context.host().getActiveTurn(binding),
      binding,
      navigation,
    });
    const threadTitle = normalizeConversationTitle(threadState.title);
    if (!threadTitle) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("status-sync-name-missing-title"),
          createdAt: this.context.now(),
          title: "Name sync unavailable",
          body: "This thread does not have a Codex thread name to sync yet.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const result = await this.context.adapter.setConversationTitle({
      ...target,
      title: threadTitle,
    });
    if (result.outcome !== "updated") {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("status-sync-name-failed"),
          createdAt: this.context.now(),
          title: "Name sync unavailable",
          body:
            result.errorMessage ??
            `This ${conversationKindLabel(binding.channel.conversation.kind)} cannot be renamed from messaging.`,
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const updatedBinding = await this.context.store.upsertBinding({
      ...binding,
      channel: {
        ...binding.channel,
        conversation: {
          ...binding.channel.conversation,
          title: result.title,
        },
      },
      updatedAt: this.context.now(),
    });
    // Title changed — make the chip's label/tooltip pick up the new
    // value without waiting for the next backend tick.
    this.notifyBindingChanged("sync-conversation-name");
    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("status-sync-name-confirmed"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: "Name synced",
        body: `Set this ${conversationKindLabel(binding.channel.conversation.kind)} name to "${result.title}".`,
      }),
      updatedBinding,
      event,
    );
    await this.renderBindingStatus(updatedBinding, event);
  }

  private conversationTitleTarget(binding: MessagingBindingRecord, event?: MessagingInboundEvent) {
    return {
      actor: event?.actor,
      channel: binding.channel,
      routingState: event?.routingState ?? binding.routingState,
    };
  }

  async updateBindingPreferences(
    binding: MessagingBindingRecord,
    patch: Partial<NonNullable<MessagingBindingRecord["preferences"]>>,
  ): Promise<MessagingBindingRecord> {
    return await this.context.store.upsertBinding({
      ...binding,
      preferences: {
        ...binding.preferences,
        ...patch,
        updatedAt: this.context.now(),
      },
      updatedAt: this.context.now(),
    });
  }

  async detachBinding(event: MessagingInboundEvent): Promise<void> {
    const binding = await this.context.store.findActiveBindingForChannel(event.channel);
    const channelMonitor =
      await this.context.store.findActiveMonitorSubscriptionForChannel(event.channel);
    const hasThread = Boolean(binding);
    const hasChannelMonitor = channelMonitor?.monitor.enabled === true;
    const hasBindingMonitor = binding?.monitor?.enabled === true;
    const hasMonitor = hasChannelMonitor || hasBindingMonitor;
    if (!hasThread && !hasMonitor) {
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("detach-unbound"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          title: "Nothing attached",
          body: "Neither a thread nor Monitor is attached to this conversation.",
        }),
        undefined,
        event,
      );
      return;
    }

    if (channelMonitor && hasChannelMonitor) {
      await this.context.host().disableChannelMonitorSubscription(channelMonitor, event);
    }
    if (binding) {
      await this.runDetachPipeline(binding, event, {
        deliverConfirmation: false,
        deliverMonitorStatus: false,
      });
    }

    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("detached"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: hasThread && hasMonitor
          ? "Thread and Monitor detached"
          : hasThread
            ? "Thread detached"
            : "Monitor detached",
        body: hasThread && hasMonitor
          ? "Messages in this conversation will no longer route to PwrAgent, and recent thread updates will no longer post here."
          : hasThread
            ? "Messages in this conversation will no longer route to PwrAgent."
            : "Recent thread updates will no longer post to this conversation.",
      }),
      binding,
      event,
    );
  }

  /**
   * Platform-agnostic detach pipeline. Called by both the inbound
   * `/detach` slash-command path and the bus-driven UI / archive
   * paths. The delivery host reaches the current registered adapter,
   * which implements the messaging contract — adding a new platform
   * requires zero changes to this method. `event` is supplied only
   * when the detach was initiated by an inbound command (used for
   * audit context and reply targeting); for non-inbound origins
   * (`requestBindingRevoke` from IPC, archive flows) the binding's
   * own channel is the routing source.
   */
  private async runDetachPipeline(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    options: {
      deliverConfirmation?: boolean;
      deliverMonitorStatus?: boolean;
    } = {},
  ): Promise<void> {
    const activeTurn = this.context.host().getActiveTurn(binding);
    if (activeTurn) {
      await this.context.host().signalTurnActivity(
        binding,
        {
          ...activeTurn,
          status: "interrupted",
          updatedAt: this.context.now(),
        },
        { force: true },
      );
    }
    await this.context.host().deliver(
      buildActivityIntent({
        id: this.context.host().newIntentId("activity-closed"),
        activity: "typing",
        bindingId: binding.id,
        createdAt: this.context.now(),
        sessionState: "closed",
        state: "idle",
      }),
      binding,
      event,
    );
    await this.context.host().flushToolUpdatesForBinding(binding, { clear: true });
    const stoppedBinding = await this.context.host().stopMonitoringForBinding(binding, event, {
      deliverStatus: options.deliverMonitorStatus,
    });
    await this.retireBindingStatus(
      stoppedBinding,
      event,
      { kind: "thread", thread: await this.context.host().readBoundNavigationThread(binding) },
    );

    await this.context.store.revokeBinding({
      bindingId: binding.id,
      revokedAt: this.context.now(),
    });
    await this.recordBindingTransition("unbound", binding);
    this.notifyBindingChanged("detach");
    if (options.deliverConfirmation !== false) {
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("detached"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          title: "Thread detached",
          body: "Messages in this conversation will no longer route to PwrAgent.",
        }),
        binding,
        event,
      );
    }
  }

  /**
   * Bus-driven entry point used by the runtime when an UI / archive
   * caller emits `requestBindingRevoke`. Returns true if this
   * controller's adapter owns the binding's channel and therefore
   * handled the revoke; false otherwise so the runtime can try the
   * next controller (or fall back to a direct store revoke if no
   * controller matches — e.g., messaging is currently disabled).
   */
  async handleBindingRevokeRequest(
    binding: MessagingBindingRecord,
  ): Promise<boolean> {
    if (!this.context.host().isChannelInScope(binding.channel)) {
      return false;
    }
    await this.runDetachPipeline(binding, undefined);
    return true;
  }

  async recreateBindingStatus(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<MessagingBindingRecord> {
    await this.clearActiveBindingSubmodeIntent(event, binding);
    const snapshot: MessagingThreadContext = { kind: "thread", thread: await this.context.host().readBoundNavigationThread(binding) };
    const retiredBinding = await this.retireBindingStatus(binding, event, snapshot);
    return await this.renderBindingStatus(retiredBinding, event, snapshot);
  }

  async resolveToolUpdateDefaultMode(
    targetKind: MessagingBindingTargetKind = "thread",
  ): Promise<MessagingToolUpdateMode> {
    const configured = this.context.config.toolUpdateDefaultMode;
    if (!configured) {
      return targetKind === "agent_thread" ? "show_none" : "show_some";
    }

    try {
      return typeof configured === "function"
        ? await configured(targetKind)
        : configured;
    } catch (error) {
      this.context.logger.debug?.("messaging tool update default resolution failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return targetKind === "agent_thread" ? "show_none" : "show_some";
    }
  }

  /**
   * Resolve the global "show streaming option on thread cards" setting. Resolved
   * live (like {@link resolveToolUpdateDefaultMode}) rather than snapshotted at
   * construction, so toggling it in Settings takes effect on the next status
   * render instead of only after a messaging restart.
   */
  async resolveShowStreamingOption(): Promise<boolean> {
    const configured = this.context.host().showStreamingOptionConfig;
    try {
      return typeof configured === "function" ? await configured() : configured;
    } catch (error) {
      this.context.logger.debug?.("messaging show-streaming-option resolution failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async retireBindingStatus(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent | undefined,
    navigation: MessagingNavigationContext,
  ): Promise<MessagingBindingRecord> {
    const statusSurface = binding.statusSurface ?? binding.pinnedStatusSurface;
    if (!statusSurface) {
      return binding;
    }

    try {
      await this.context.host().deliver(
        {
          ...buildBindingStatusIntent({
            id: this.context.host().newIntentId("status-retire"),
            binding,
            capabilityProfile: this.context.capabilityProfile,
            contextUsageSummary: this.context.host().contextUsageSummaryForBinding(binding),
            createdAt: this.context.now(),
            responseModeDefault: await this.context.host().responseModeForConversation(
              binding.channel,
            ),
            threadState: resolveMessagingThreadState({
              activeTurn: this.context.host().getActiveTurn(binding),
              binding,
              navigation,
            }),
            toolUpdateMode: await this.resolveToolUpdateDefaultMode(
              binding.targetKind ?? "thread",
            ),
          }),
          actions: [],
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "fail",
          },
          targetSurface: statusSurface,
        },
        binding,
        event,
      );
    } catch (error) {
      this.context.logger.debug?.("messaging status retirement update failed", {
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
    }

    if (binding.pinnedStatusSurface) {
      try {
        await this.context.host().deliver(
          {
            id: this.context.host().newIntentId("status-unpin"),
            kind: "dismiss",
            bindingId: binding.id,
            createdAt: this.context.now(),
            delivery: {
              mode: "dismiss",
              unpin: true,
            },
            reason: "status_recreated",
            targetSurface: binding.pinnedStatusSurface,
          },
          binding,
          event,
        );
      } catch (error) {
        this.context.logger.debug?.("messaging status retirement unpin failed", {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    }

    return await this.context.store.upsertBinding({
      ...binding,
      pinnedStatusSurface: undefined,
      statusSurface: undefined,
      updatedAt: this.context.now(),
    }, { expectedActiveBinding: binding, mergeActiveBinding: mergeRetiredBindingStatus });
  }

  async renderBindingStatus(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: MessagingNavigationContext,
  ): Promise<MessagingBindingRecord> {
    return await this.statusRenderLock.run(binding.id, async () => {
      const latestBinding = await this.context.store.getBinding(binding.id);
      if (latestBinding?.revokedAt) {
        return latestBinding;
      }
      return await this.renderBindingStatusUnlocked(
        latestBinding ?? binding,
        event,
        navigation,
      );
    });
  }

  private async renderBindingStatusUnlocked(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: MessagingNavigationContext,
  ): Promise<MessagingBindingRecord> {
    if (isDefaultAgentRouteBinding(binding)) {
      return binding;
    }
    if (!event && await this.hasActiveBindingSubmodeIntent(binding)) {
      this.context.logger.debug?.("messaging deferred automatic status refresh during active interaction", {
        bindingId: binding.id,
        threadId: binding.threadId,
      });
      return await this.context.store.getBinding(binding.id) ?? binding;
    }
    const federationTarget = federationTargetForBinding(binding);
    const snapshot = navigation ?? { kind: "thread" as const, thread: await this.context.host().readBoundNavigationThread(binding) };
    const activeTurn = await this.context.host().reconcileActiveTurnFromBackendStatus(
      binding,
      "status_refresh",
    );
    const backendSummary = await this.context.host().getBackendSummary(
      binding.backend,
      federationTarget,
    );
    const intent = buildBindingStatusIntent({
      id: this.context.host().newIntentId("status"),
      allowFullAccessEscalation: (await this.context.host().resolveFullAccessControls())
        .allowEscalation,
      backendSummary,
      binding,
      canSyncName: Boolean(this.context.adapter.setConversationTitle)
        && this.context.adapter.supportsConversationTitle?.(this.conversationTitleTarget(binding, event)) !== false,
      capabilityProfile: this.context.capabilityProfile,
      contextUsageSummary: this.context.host().contextUsageSummaryForBinding(binding),
      createdAt: this.context.now(),
      handoff: this.context.backend.handoffThreadWorkspace
        ? handoffContextForBinding(binding, snapshot)
        : undefined,
      responseModeDefault: await this.context.host().responseModeForConversation(
        binding.channel,
      ),
      streamingResponsesDefault: this.context.host().streamingResponsesDefault,
      showStreamingOption: await this.resolveShowStreamingOption(),
      threadState: resolveMessagingThreadState({
        activeTurn,
        binding,
        navigation: snapshot,
      }),
      toolUpdateMode: await this.resolveToolUpdateDefaultMode(
        binding.targetKind ?? "thread",
      ),
    });
    const result = await this.context.host().deliver(intent, binding, event);
    const latestBinding = await this.context.store.getBinding(binding.id);
    if (latestBinding?.revokedAt) {
      return latestBinding;
    }
    if (!result.surface) {
      return latestBinding ?? binding;
    }

    const currentBinding = latestBinding ?? binding;
    return await this.context.store.upsertBinding({
      ...currentBinding,
      pinnedStatusSurface:
        result.outcome === "pinned"
          ? result.surface
          : currentBinding.pinnedStatusSurface,
      statusSurface: result.surface,
      updatedAt: this.context.now(),
    });
  }

  async renderAutomaticBindingStatus(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: MessagingNavigationContext,
  ): Promise<MessagingBindingRecord> {
    if (
      binding.statusPresentation === "on_demand"
      && !binding.statusSurface
      && !binding.pinnedStatusSurface
    ) {
      return binding;
    }
    const targetedNavigation = navigation
      ?? threadContextForAdmissionState(
        binding,
        await this.context.backend.getThreadAdmissionState({
          backend: binding.backend,
          federationTarget: federationTargetForBinding(binding),
          threadId: binding.threadId,
        }),
      );
    return await this.renderBindingStatus(binding, event, targetedNavigation);
  }

  async threadContextWithNameFromEvent(
    binding: MessagingBindingRecord,
    event: AgentEvent,
  ): Promise<MessagingThreadContext> {
    const thread = await this.context.host().readBoundNavigationThread(binding);
    const params = event.notification.params as { threadId?: unknown; threadName?: unknown; titleSource?: unknown };
    if (!thread || params.threadId !== thread.id || typeof params.threadName !== "string" || !params.threadName.trim()) {
      return { kind: "thread", thread };
    }
    return { kind: "thread", thread: { ...thread, title: params.threadName.trim(),
      titleSource: normalizeRenamedTitleSource(params.titleSource) } };
  }

  /**
   * Best-effort fan-out to the runtime's bindings-changed listener.
   * Wrapped so a misbehaving listener (e.g. closed BrowserWindow) can
   * never abort the mutation that produced the event.
   */
  notifyBindingChanged(reason: string): void {
    if (!this.context.config.onBindingChanged) return;
    try {
      this.context.config.onBindingChanged();
    } catch (error) {
      this.context.logger.debug?.("messaging onBindingChanged listener threw", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async recordBindingTransition(
    action: ThreadMessagingBindingTransition["action"],
    binding: MessagingBindingRecord,
    occurredAt: number = this.context.now(),
  ): Promise<void> {
    const conversation = binding.channel.conversation;
    const transition: ThreadMessagingBindingTransition = {
      id: randomUUID(),
      action,
      bindingId: binding.id,
      platform: binding.channel.channel,
      conversationKind: conversation.kind,
      conversationTitle: conversation.title,
      parentTitle: conversation.parentTitle,
      ancestorTitle: conversation.ancestorTitle,
      occurredAt,
    };
    if (this.context.backend.recordMessagingBindingTransition) {
      try {
        await this.context.backend.recordMessagingBindingTransition({
          backend: binding.backend,
          threadId: binding.threadId,
          transition,
        });
      } catch (error) {
        this.context.logger.debug?.("messaging binding-transition audit failed", {
          action,
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    }
    this.recordBindingActivity(action, binding, occurredAt);
  }

  async bindChannelToThread(
    event: MessagingInboundEvent,
    target: {
      backend: AppServerBackendKind;
      federatedThread?: FederatedThreadRef;
      recordTransition?: boolean;
      statusPresentation?: MessagingBindingRecord["statusPresentation"];
      threadId: ThreadIdentifier;
      targetKind?: MessagingBindingRecord["targetKind"];
    },
  ): Promise<MessagingBindingRecord> {
    // Scope backstop. EVERY bind funnels through here, so a caller that forgets
    // the gate still cannot create a remote binding. Interactive entry points
    // check first and deliver a proper denial; reaching this throw means a path
    // was missed, so it fails closed loudly (the runtime's inbound dispatch
    // logs it) instead of quietly binding a peer's thread.
    if (
      !(await this.context.host().requireRemoteScope(
        event,
        target.federatedThread?.target,
        "bind:remote-instance",
      ))
    ) {
      throw new Error(
        "Refusing to bind a thread on another instance: actor lacks federation.remote_control.",
      );
    }
    const now = this.context.now();
    const previousBinding = await this.context.store.findActiveBindingForChannel(
      event.channel,
    );
    const targetIdentity = target.federatedThread
      ? federatedThreadIdentityKey(target.federatedThread)
      : buildThreadIdentityKey(target.backend, target.threadId);
    const binding: MessagingBindingRecord = {
      id: `binding:${buildMessagingConversationKey(event.channel)}:${targetIdentity}`,
      channel: event.channel,
      targetKind: target.targetKind ?? "thread",
      backend: target.backend,
      threadId: target.threadId,
      federatedThread: target.federatedThread,
      authorizedActorIds: [event.actor.platformUserId],
      routingState: event.routingState,
      statusPresentation: target.statusPresentation,
      createdAt: now,
      updatedAt: now,
      displayName: event.actor.displayName ?? event.actor.username,
    };
    if (
      previousBinding &&
      (previousBinding.id !== binding.id ||
        previousBinding.backend !== binding.backend ||
        previousBinding.threadId !== binding.threadId ||
        !federationRefsMatch(
          previousBinding.federatedThread,
          binding.federatedThread,
        ))
    ) {
      await this.context.store.revokeBinding({
        bindingId: previousBinding.id,
        revokedAt: now,
      });
    }
    const upserted = await this.context.store.upsertBinding(binding);
    if (
      target.recordTransition !== false &&
      previousBinding &&
      (previousBinding.backend !== upserted.backend ||
        previousBinding.threadId !== upserted.threadId ||
        !federationRefsMatch(
          previousBinding.federatedThread,
          upserted.federatedThread,
        ))
    ) {
      await this.recordBindingTransition("unbound", previousBinding, now);
    }
    if (
      target.recordTransition !== false &&
      (
        !previousBinding ||
        previousBinding.backend !== upserted.backend ||
        previousBinding.threadId !== upserted.threadId ||
        !federationRefsMatch(
          previousBinding.federatedThread,
          upserted.federatedThread,
        )
      )
    ) {
      await this.recordBindingTransition("bound", upserted, now);
    }
    // Retire any channel-scoped pending intents that pre-date this
    // bind. Without this, the resume browser's pending intent (and any
    // other pre-binding picker intent) survives the bind, and the next
    // text inbound on this channel matches the stale picker — making
    // the bot bounce "Choose an option" instead of routing to the new
    // binding. Best-effort: log and continue if the cleanup fails so
    // the bind itself still succeeds (fresh binding is the source of
    // truth; stale intents will eventually be evicted by TTL GC).
    //
    // Not transactional with `upsertBinding` on purpose: the store
    // API doesn't expose a transaction boundary for cross-row work,
    // and adding one would push transaction plumbing into the
    // messaging interface — over-architecture for a recovery window
    // measured in minutes. If the process crashes between these two
    // writes, the next bind on the same channel re-runs the cleanup,
    // and the TTL GC catches anything missed within 15 minutes.
    try {
      const removed = await this.context.store.deletePendingIntentsForChannel({
        channel: event.channel,
      });
      if (removed.length > 0) {
        this.context.logger.debug?.("messaging retired channel pending intents on bind", {
          bindingId: upserted.id,
          channel: event.channel.channel,
          removedCount: removed.length,
        });
      }
    } catch (error) {
      this.context.logger.debug?.(
        "messaging channel pending-intent cleanup failed on bind",
        {
          bindingId: upserted.id,
          channel: event.channel.channel,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    // Renderer's binding chip is fed by the navigation snapshot. The
    // snapshot only refetches on backend events — and binding creation
    // doesn't emit one. Fan out a bindings-changed notification so the
    // UI picks up the new chip immediately (issue #191).
    this.notifyBindingChanged("bind");
    return upserted;
  }

  private recordBindingActivity(
    action: ThreadMessagingBindingTransition["action"],
    binding: MessagingBindingRecord,
    occurredAt: number,
  ): void {
    try {
      const conversation = binding.channel.conversation;
      const log = this.context.host().desktopActivityLog();
      if (!log) return;
      log.record({
        platform: binding.channel.channel,
        kind: "binding",
        backend: binding.backend,
        threadId: binding.threadId,
        bindingId: binding.id,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        summary: `Channel ${action}: ${describeConversation(conversation)} / ${binding.threadId}`,
        createdAt: occurredAt,
        payload: {
          action,
          conversationKind: conversation.kind,
          conversationParentId: conversation.parentId,
          parentTitle: conversation.parentTitle,
          ancestorTitle: conversation.ancestorTitle,
        },
      });
    } catch {
      // Activity log is best-effort observability.
    }
  }
}
