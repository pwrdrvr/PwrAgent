import type { MessagingMonitorContext } from "./messaging-monitor-context";
import { topicChannelRef } from "./messaging-callback-helpers";
import { type MonitorCommandAction } from "./messaging-command-helpers";
import { federationTargetForBinding, type MessagingCancellationSignal, type MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { MessagingBindingRecord, MessagingActiveTurnSummary, MessagingChannelRef, MessagingInboundCommandEvent, MessagingInboundEvent, MessagingManagedTopicRecord, MessagingMonitorState, MessagingMonitorSubscriptionRecord, MessagingTopicCleanupProposalItem, MessagingTopicCleanupProposalRecord } from "@pwragent/messaging-interface";
import { buildMonitorStatusIntent, MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT, MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT, MESSAGING_MONITOR_INTERVAL_MS, normalizeMonitorThreadLimit, selectMonitorThreads, type MessagingMonitorNavigation, type MessagingMonitorRows } from "./messaging-monitor-card.js";
import { buildConfirmationIntent, buildErrorIntent } from "./messaging-renderer.js";
import { buildMessagingConversationKey } from "./messaging-store.js";
import { buildMessagingAuditContext } from "./messaging-audit.js";
import { federationTargetForThread, threadKeyForNavigationThread, formatTimeOfDay, resolveMonitorStateOptions, buildMonitorSubscriptionId, managedTopicRecordFromConversation, topicTitleForThread, formatManagedTopicRights, formatTopicCleanupProposalBody, isPermanentMessagingTargetFailure } from "./messaging-monitor-helpers";

export class MessagingMonitorWorkflow {
  private readonly monitorTimersByBindingId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly monitorTimersBySubscriptionId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  private readonly monitorRenders = new Map<string, MessagingCancellationSignal>();

  constructor(private readonly context: MessagingMonitorContext) {}

  dispose(): void {
    for (const timer of this.monitorTimersByBindingId.values()) {
      clearTimeout(timer);
    }
    this.monitorTimersByBindingId.clear();
    for (const timer of this.monitorTimersBySubscriptionId.values()) {
      clearTimeout(timer);
    }
    this.monitorTimersBySubscriptionId.clear();
    for (const render of this.monitorRenders.values()) {
      render.cancel();
    }
    this.monitorRenders.clear();
  }

  async startMonitoringForEnabledBindings(): Promise<void> {
    await this.context.host().cleanupExpiredPrivateReplyContinuations();
    if (this.context.config.channel) {
      const subscriptions =
        await this.context.store.findActiveMonitorSubscriptionsForChannelKind({
          channel: this.context.config.channel,
        });
      for (const subscription of subscriptions) {
        if (subscription.monitor.enabled) {
          await this.runMonitorSubscriptionTick(subscription);
        }
      }
    }

    const backends = await this.resolveMonitorBackendKinds();
    for (const backend of backends) {
      const bindings = this.context.host().filterBindingsForChannel(
        await this.context.store.findActiveBindingsForBackend({ backend }),
      );
      for (const binding of bindings) {
        if (binding.monitor?.enabled) {
          await this.runMonitorTick(binding.id);
        }
      }
    }
  }

  supportsMonitorTopicControls(channel: MessagingChannelRef): boolean {
    return channel.channel === "telegram" &&
      (channel.conversation.kind === "topic" || channel.conversation.kind === "channel");
  }

  async resolveMonitorControlTopic(
    event: MessagingInboundCommandEvent,
  ): Promise<MessagingManagedTopicRecord | undefined> {
    if (event.channel.conversation.kind === "topic") {
      return await this.upsertManagedTopicFromChannel(event, {
        source: "owned",
        lifecycle: "open",
        recommendation: "keep",
      });
    }

    if (event.channel.conversation.kind !== "channel") {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("topics-not-supergroup"),
          createdAt: this.context.now(),
          title: "Telegram supergroup required",
          body: "Open Monitor from a Telegram supergroup or one of its topics so PwrAgent can manage forum topics.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return undefined;
    }

    const supergroupId = event.channel.conversation.id;
    const knownTopics = await this.context.store.findManagedTopicsForSupergroup({
      channel: event.channel.channel,
      supergroupId,
    });
    const existing = knownTopics.find(
      (topic) => topic.source === "owned" && topic.lifecycle !== "deleted",
    );
    if (existing) {
      return existing;
    }

    if (!this.context.adapter.createManagedConversation) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("topics-create-unsupported"),
          createdAt: this.context.now(),
          title: "Topic creation unavailable",
          body: "This adapter cannot create a PwrAgent control topic. Run this from an existing Telegram topic to adopt it instead.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return undefined;
    }

    const result = await this.context.adapter.createManagedConversation({
      actor: event.actor,
      parent: event.channel,
      routingState: event.routingState,
      title: "PwrAgent topic owner",
    });
    if (result.outcome !== "created" || !result.conversation) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("topics-create-failed"),
          createdAt: this.context.now(),
          title: "Topic creation failed",
          body: result.errorMessage ?? "Telegram could not create the PwrAgent control topic.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return undefined;
    }

    return await this.context.store.upsertManagedTopic(
      managedTopicRecordFromConversation({
        actorIds: this.context.host().monitorAuthorizedActorIds(event),
        channel: event.channel.channel,
        conversation: result.conversation,
        now: this.context.now(),
        routingState: result.routingState,
        source: "owned",
      }),
    );
  }

  eventForManagedTopic(
    event: MessagingInboundEvent,
    topic: MessagingManagedTopicRecord,
    args: string[],
  ): MessagingInboundCommandEvent {
    return {
      ...event,
      id: `${event.id}:topic:${topic.id}`,
      kind: "command",
      channel: topicChannelRef(topic, event.channel.connectionId),
      command: "monitor",
      args,
      rawText: `/monitor ${args.join(" ")}`,
      routingState: topic.routingState ?? event.routingState,
    };
  }

  async deliverInvalidTopicApproval(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.context.host().deliver(
      buildErrorIntent({
        id: this.context.host().newIntentId("topics-approval-invalid"),
        createdAt: this.context.now(),
        title: "Topic action expired",
        body: "That cleanup proposal is no longer active. Run /monitor topics cleanup to refresh it.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  async renderTopicControlStatus(
    event: MessagingInboundEvent,
    topic: MessagingManagedTopicRecord,
  ): Promise<void> {
    const rights = await this.context.adapter.getManagedConversationRights?.({
      actor: event.actor,
      channel: event.channel,
      routingState: event.routingState,
    });
    const topics = await this.context.store.findManagedTopicsForSupergroup({
      channel: event.channel.channel,
      supergroupId: topic.supergroupId,
    });
    const rightsLines = rights
      ? formatManagedTopicRights(rights.operations)
      : ["Topic operations: unsupported by this adapter"];
    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("topics-control"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: "PwrAgent topic owner",
        body: [
          `Control topic: ${topic.title ?? topic.topicId}`,
          `Known topics: ${topics.length}`,
          "",
          ...rightsLines,
          "",
          "Use /monitor topics cleanup for a dry-run cleanup proposal.",
          "Use /monitor topics fanout to create or reuse per-thread monitor topics.",
        ].join("\n"),
        actions: [
          {
            id: "monitor:topics:cleanup",
            label: "Dry Run Cleanup",
            style: "secondary",
            fallbackText: "/monitor topics cleanup",
          },
          {
            id: "monitor:topics:fanout",
            label: "Fanout",
            style: "secondary",
            fallbackText: "/monitor topics fanout",
          },
        ],
      }),
      undefined,
      event,
    );
  }

  async renderTopicCleanupProposal(
    event: MessagingInboundEvent,
    controlTopic: MessagingManagedTopicRecord,
  ): Promise<void> {
    const topics = await this.context.store.findManagedTopicsForSupergroup({
      channel: event.channel.channel,
      supergroupId: controlTopic.supergroupId,
    });
    const now = this.context.now();
    const items = topics
      .filter((topic) => topic.lifecycle !== "deleted")
      .map((topic): MessagingTopicCleanupProposalItem => {
        const action =
          topic.id === controlTopic.id ||
          topic.source === "owned" ||
          topic.source === "linked"
            ? "keep"
            : topic.lifecycle === "closed"
              ? "delete"
              : "close";
        return {
          id: topic.topicId,
          action,
          reason:
            action === "keep"
              ? "owned or linked topic"
              : action === "delete"
                ? "already closed known topic"
                : "known topic not owned or linked to a PwrAgent thread",
          title: topic.title,
          topicRecordId: topic.id,
        };
      });
    const proposal: MessagingTopicCleanupProposalRecord = {
      id: `topic-cleanup:${controlTopic.supergroupId}:${now}`,
      authorizedActorIds: this.context.host().monitorAuthorizedActorIds(event),
      channel: event.channel.channel,
      controlTopicRecordId: controlTopic.id,
      createdAt: now,
      items,
      status: "pending",
      supergroupId: controlTopic.supergroupId,
      updatedAt: now,
    };
    await this.context.store.upsertTopicCleanupProposal(proposal);
    const actions = items
      .filter((item) => item.action === "close" || item.action === "delete")
      .slice(0, 6)
      .map((item) => ({
        id: `monitor:topics:approve:${proposal.id}:${item.id}`,
        label: `${item.action === "delete" ? "Delete" : "Close"} ${item.title ?? item.id}`,
        style: item.action === "delete" ? "danger" as const : "secondary" as const,
        fallbackText: `/monitor topics approve ${proposal.id} ${item.id}`,
      }));
    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("topics-cleanup"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: now,
        title: "Topic cleanup dry run",
        body: formatTopicCleanupProposalBody(items),
        actions,
      }),
      undefined,
      event,
    );
  }

  async runTopicMonitorFanout(
    event: MessagingInboundEvent,
    controlTopic: MessagingManagedTopicRecord,
  ): Promise<void> {
    if (!this.context.adapter.createManagedConversation) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("topics-fanout-unsupported"),
          createdAt: this.context.now(),
          title: "Topic creation unavailable",
          body: "This adapter cannot create managed topics.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const snapshot = await this.readMonitorRows();
    const selected = selectMonitorThreads({ navigation: snapshot }).threads.slice(0, 3);
    const created: string[] = [];
    const reused: string[] = [];
    const failed: string[] = [];
    for (const row of selected) {
      const target = federationTargetForThread(row);
      const thread = await this.context.host().readExactNavigationThread({ ref: { backend: row.source, threadId: row.id,
        ...(target?.scope === "remote" ? { ownerInstanceId: target.instanceId } : {}) }, federationTarget: target });
      if (!thread || thread.archivedAt) {
        failed.push(row.title);
        continue;
      }
      const existing = await this.context.store.findThreadTopicLink({
        backend: thread.source,
        channel: event.channel.channel,
        supergroupId: controlTopic.supergroupId,
        threadId: thread.id,
      });
      if (existing) {
        const topic = await this.context.store.getManagedTopic(existing.topicRecordId);
        if (topic) {
          await this.ensureManagedTopicBinding(event, topic, thread);
        }
        reused.push(thread.title);
        continue;
      }
      const result = await this.context.adapter.createManagedConversation({
        actor: event.actor,
        parent: event.channel,
        routingState: event.routingState,
        title: topicTitleForThread(thread),
      });
      if (result.outcome !== "created" || !result.conversation) {
        failed.push(thread.title);
        continue;
      }
      const topic = await this.context.store.upsertManagedTopic(
        managedTopicRecordFromConversation({
          actorIds: this.context.host().monitorAuthorizedActorIds(event),
          channel: event.channel.channel,
          conversation: result.conversation,
          now: this.context.now(),
          routingState: result.routingState,
          source: "linked",
        }),
      );
      await this.context.store.upsertThreadTopicLink({
        id: `topic-link:${event.channel.channel}:${controlTopic.supergroupId}:${thread.source}:${thread.id}`,
        backend: thread.source,
        channel: event.channel.channel,
        createdAt: this.context.now(),
        supergroupId: controlTopic.supergroupId,
        threadId: thread.id,
        topicRecordId: topic.id,
        updatedAt: this.context.now(),
      });
      const bindingOutcome = await this.ensureManagedTopicBinding(event, topic, thread);
      if (bindingOutcome === "conflict") {
        failed.push(thread.title);
        continue;
      }
      await this.deliverTopicSeed(event, topic, thread);
      created.push(thread.title);
    }

    await this.context.host().deliver(
      buildConfirmationIntent({
        id: this.context.host().newIntentId("topics-fanout"),
        capabilityProfile: this.context.capabilityProfile,
        createdAt: this.context.now(),
        title: "Topic fanout complete",
        body: [
          `Created: ${created.length}${created.length ? ` (${created.join(", ")})` : ""}`,
          `Reused: ${reused.length}${reused.length ? ` (${reused.join(", ")})` : ""}`,
          `Failed: ${failed.length}${failed.length ? ` (${failed.join(", ")})` : ""}`,
        ].join("\n"),
        actions: [],
      }),
      undefined,
      event,
    );
  }

  async deliverTopicSeed(
    event: MessagingInboundEvent,
    topic: MessagingManagedTopicRecord,
    thread: NavigationThreadSummary,
  ): Promise<void> {
    const project =
      thread.linkedDirectories[0]?.label ??
      thread.linkedDirectories[0]?.path;
    await this.context.host().deliver({
      id: this.context.host().newIntentId("topic-seed"),
      kind: "message",
      createdAt: this.context.now(),
      audit: buildMessagingAuditContext({
        action: "topics.seed",
        actor: event.actor,
        backend: thread.source,
        channel: topicChannelRef(topic, event.channel.connectionId),
        now: this.context.now(),
        threadId: thread.id,
      }),
      parts: [
        {
          type: "text",
          text: [
            `Monitoring: ${thread.title}`,
            `Backend: ${thread.source}`,
            project ? `Project: ${project}` : undefined,
            thread.updatedAt ? `Updated: ${formatTimeOfDay(thread.updatedAt)}` : undefined,
            "",
            "This topic is attached to the thread for follow-up messages.",
          ].filter(Boolean).join("\n"),
        },
      ],
    });
  }

  async ensureManagedTopicBinding(
    event: MessagingInboundEvent,
    topic: MessagingManagedTopicRecord,
    thread: NavigationThreadSummary,
  ): Promise<"bound" | "existing" | "conflict"> {
    const channel = topicChannelRef(topic, event.channel.connectionId);
    const existing = await this.context.store.findActiveBindingForChannel(channel);
    if (existing) {
      if (existing.backend === thread.source && existing.threadId === thread.id) {
        return "existing";
      }
      this.context.logger.debug?.("managed topic already bound to another thread", {
        backend: existing.backend,
        bindingId: existing.id,
        threadId: existing.threadId,
        topicId: topic.topicId,
      });
      return "conflict";
    }

    await this.context.host().bindChannelToThread(
      {
        ...event,
        id: `${event.id}:topic-bind:${topic.id}`,
        kind: "command",
        channel,
        command: "monitor",
        args: ["topics", "fanout"],
        rawText: "/monitor topics fanout",
        receivedAt: this.context.now(),
        routingState: topic.routingState ?? event.routingState,
      } satisfies MessagingInboundCommandEvent,
      {
        backend: thread.source,
        threadId: thread.id,
      },
    );
    return "bound";
  }

  async observeManagedTopicFromInbound(
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (
      event.channel.conversation.kind !== "topic" ||
      !event.channel.conversation.parentId
    ) {
      return;
    }
    const observedAt = event.receivedAt;
    await this.context.store.mergeManagedTopicObservation({
      ...managedTopicRecordFromConversation({
        actorIds: this.context.host().monitorAuthorizedActorIds(event),
        channel: event.channel.channel,
        conversation: event.channel.conversation,
        now: observedAt,
        routingState: event.routingState,
        source: "observed",
      }),
      lastObservedAt: observedAt,
      lifecycle: "open",
      updatedAt: observedAt,
    });
  }

  async upsertManagedTopicFromChannel(
    event: MessagingInboundEvent,
    options: Pick<
      MessagingManagedTopicRecord,
      "source" | "lifecycle" | "recommendation"
    >,
  ): Promise<MessagingManagedTopicRecord> {
    const now = this.context.now();
    const existing = await this.context.store.findManagedTopicByConversation({
      channel: event.channel.channel,
      supergroupId: event.channel.conversation.parentId ?? "",
      topicId: event.channel.conversation.id,
    });
    return await this.context.store.upsertManagedTopic({
      ...managedTopicRecordFromConversation({
        actorIds: this.context.host().monitorAuthorizedActorIds(event),
        channel: event.channel.channel,
        conversation: event.channel.conversation,
        now,
        routingState: event.routingState,
        source: options.source,
      }),
      ...existing,
      authorizedActorIds: existing?.authorizedActorIds.length
        ? existing.authorizedActorIds
        : this.context.host().monitorAuthorizedActorIds(event),
      lastObservedAt: now,
      lifecycle: options.lifecycle,
      recommendation: options.recommendation ?? existing?.recommendation,
      routingState: event.routingState ?? existing?.routingState,
      source: existing?.source === "owned" || existing?.source === "linked"
        ? existing.source
        : options.source,
      updatedAt: now,
    });
  }

  async enableAndRenderChannelMonitor(
    event: MessagingInboundEvent,
    action: MonitorCommandAction = { kind: "start" },
  ): Promise<MessagingMonitorSubscriptionRecord> {
    const existing =
      await this.context.store.findActiveMonitorSubscriptionForChannel(event.channel);
    const now = this.context.now();
    const monitorOptions = resolveMonitorStateOptions(existing?.monitor, action);
    const subscriptionId = existing?.id ?? buildMonitorSubscriptionId(event.channel);
    return await this.withMonitorRender(channelMonitorRenderKey(event.channel), async (render) => {
      const subscription = await this.context.store.upsertMonitorSubscription({
        id: subscriptionId,
        channel: event.channel,
        authorizedActorIds: existing?.authorizedActorIds.length
          ? existing.authorizedActorIds
          : this.context.host().monitorAuthorizedActorIds(event),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        monitor: {
          ...existing?.monitor,
          enabled: true,
          intervalMs: monitorOptions.intervalMs,
          lastRenderedAt: existing?.monitor.lastRenderedAt,
          pinnedThreadLimit: monitorOptions.pinnedThreadLimit,
          recentThreadLimit: monitorOptions.recentThreadLimit,
          showLastResponseSnippet: monitorOptions.showLastResponseSnippet,
          showStatusLine: monitorOptions.showStatusLine,
          updatedAt: now,
        },
        monitorSurface: existing?.monitorSurface,
      });
      if (!render.isCancelled()) this.clearMonitorSubscriptionTimer(subscriptionId);
      try {
        const rendered = await this.renderChannelMonitorStatus(subscription, render, event);
        if (rendered && !render.isCancelled()) this.scheduleMonitorSubscriptionTick(rendered);
        return rendered ?? subscription;
      } catch (error) {
        this.context.logger.debug?.("messaging channel monitor initial render failed", {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId,
        });
        const latest = await this.readCurrentChannelMonitor(subscription, render);
        if (latest && !render.isCancelled()) this.scheduleMonitorSubscriptionTick(latest);
        return latest ?? subscription;
      }
    });
  }

  async stopMonitoringForChannel(
    event: MessagingInboundEvent,
  ): Promise<MessagingMonitorSubscriptionRecord | undefined> {
    const subscription =
      await this.context.store.findActiveMonitorSubscriptionForChannel(event.channel);
    if (!subscription) {
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("monitor-stopped"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: this.context.now(),
          title: "Monitor stopped",
          body: "Monitor was not running for this conversation.",
          actions: [],
        }),
        undefined,
        event,
      );
      return undefined;
    }

    const stopped = await this.persistStoppedChannelMonitor(subscription);
    const now = stopped.updatedAt;
    if (subscription.monitorSurface) {
      try {
        await this.context.host().deliver(
          buildConfirmationIntent({
            id: this.context.host().newIntentId("monitor-stopped"),
            capabilityProfile: this.context.capabilityProfile,
            createdAt: now,
            title: "Monitor stopped",
            body: "Recent thread updates will no longer post to this conversation.",
            actions: [],
            delivery: {
              mode: this.context.capabilityProfile.text.supportsMessageEdit
                ? "update"
                : "present",
              replaceMarkup: true,
              fallback: "present_new",
            },
            targetSurface: this.context.capabilityProfile.text.supportsMessageEdit
              ? subscription.monitorSurface
              : undefined,
          }),
          undefined,
          event,
        );
      } catch (error) {
        this.context.logger.debug?.("messaging channel monitor stop update failed", {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId: subscription.id,
        });
      }
    } else {
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("monitor-stopped"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: now,
          title: "Monitor stopped",
          body: "Recent thread updates will no longer post to this conversation.",
          actions: [],
        }),
        undefined,
        event,
      );
    }

    return stopped;
  }

  async enableAndRenderMonitor(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): Promise<MessagingBindingRecord> {
    return await this.withMonitorRender(`binding:${binding.id}`, async (render) => {
      const enabledBinding = await this.context.store.upsertBinding({
        ...binding,
        monitor: {
          enabled: true,
          intervalMs: binding.monitor?.intervalMs ?? MESSAGING_MONITOR_INTERVAL_MS,
          lastRenderedAt: binding.monitor?.lastRenderedAt,
          updatedAt: this.context.now(),
        },
        updatedAt: this.context.now(),
      });
      try {
        const rendered = await this.renderMonitorStatus(enabledBinding, render, event);
        if (rendered && !render.isCancelled()) this.scheduleMonitorTick(rendered);
        return rendered ?? enabledBinding;
      } catch (error) {
        this.context.logger.debug?.("messaging monitor initial render failed", {
          bindingId: enabledBinding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: enabledBinding.threadId,
        });
        const latest = await this.readCurrentBindingMonitor(enabledBinding, render);
        if (latest && !render.isCancelled()) this.scheduleMonitorTick(latest);
        return latest ?? enabledBinding;
      }
    });
  }

  async stopMonitoringForBinding(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    options: { deliverStatus?: boolean } = {},
  ): Promise<MessagingBindingRecord> {
    this.monitorRenders.get(`binding:${binding.id}`)?.cancel();
    this.clearMonitorTimer(binding.id);
    const now = this.context.now();
    const stopped = await this.context.store.upsertBinding({
      ...binding,
      monitor: {
        enabled: false,
        intervalMs: binding.monitor?.intervalMs ?? MESSAGING_MONITOR_INTERVAL_MS,
        lastRenderedAt: binding.monitor?.lastRenderedAt,
        updatedAt: now,
      },
      monitorSurface: undefined,
      updatedAt: now,
    });
    const deliverStatus = options.deliverStatus ?? true;
    if (deliverStatus && binding.monitorSurface) {
      try {
        await this.context.host().deliver(
          buildConfirmationIntent({
            id: this.context.host().newIntentId("monitor-stopped"),
            capabilityProfile: this.context.capabilityProfile,
            createdAt: now,
            title: "Monitor stopped",
            body: "Recent thread updates will no longer post to this conversation.",
            actions: [],
            delivery: {
              mode: "update",
              replaceMarkup: true,
              fallback: "present_new",
            },
            targetSurface: binding.monitorSurface,
          }),
          binding,
          event,
        );
      } catch (error) {
        this.context.logger.debug?.("messaging monitor stop update failed", {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    } else if (deliverStatus && event) {
      await this.context.host().deliver(
        buildConfirmationIntent({
          id: this.context.host().newIntentId("monitor-stopped"),
          capabilityProfile: this.context.capabilityProfile,
          createdAt: now,
          title: "Monitor stopped",
          body: binding.monitor?.enabled
            ? "Recent thread updates will no longer post to this conversation."
            : "Monitor was not running for this conversation.",
          actions: [],
        }),
        binding,
        event,
      );
    }

    return stopped;
  }

  async disableChannelMonitorSubscription(
    subscription: MessagingMonitorSubscriptionRecord,
    event?: MessagingInboundEvent,
  ): Promise<MessagingMonitorSubscriptionRecord> {
    const stopped = await this.persistStoppedChannelMonitor(subscription);
    const now = stopped.updatedAt;
    if (subscription.monitorSurface) {
      try {
        await this.context.host().deliver(
          buildConfirmationIntent({
            id: this.context.host().newIntentId("monitor-detached"),
            capabilityProfile: this.context.capabilityProfile,
            createdAt: now,
            title: "Monitor detached",
            body: "Recent thread updates will no longer post to this conversation.",
            actions: [],
            delivery: {
              mode: "update",
              replaceMarkup: true,
              fallback: "fail",
            },
            targetSurface: subscription.monitorSurface,
          }),
          undefined,
          event,
        );
      } catch (error) {
        this.context.logger.debug?.("messaging channel monitor detach update failed", {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId: subscription.id,
        });
      }
    }
    return stopped;
  }

  private async persistStoppedChannelMonitor(
    subscription: MessagingMonitorSubscriptionRecord,
  ): Promise<MessagingMonitorSubscriptionRecord> {
    // Stop owns the state transition before any confirmation can wait on a provider.
    this.monitorRenders.get(channelMonitorRenderKey(subscription.channel))?.cancel();
    this.clearMonitorSubscriptionTimer(subscription.id);
    const now = this.context.now();
    return await this.context.store.upsertMonitorSubscription({
      ...subscription,
      monitor: {
        ...subscription.monitor,
        enabled: false,
        updatedAt: now,
      },
      monitorSurface: undefined,
      updatedAt: now,
    });
  }

  async readMonitorRows(monitor?: MessagingMonitorState, federationTarget?: FederationTarget): Promise<MessagingMonitorRows> {
    const read = this.context.backend.getNavigationQueryPage?.bind(this.context.backend);
    if (!read) throw new Error("Upgrade the owning instance to navigation query protocol 2 before opening a monitor.");
    const sections = [
      { pinned: "include" as const, size: normalizeMonitorThreadLimit(monitor?.pinnedThreadLimit, MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT) },
      { pinned: "exclude" as const, size: normalizeMonitorThreadLimit(monitor?.recentThreadLimit, MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT) },
    ];
    const pages = await Promise.all(sections.filter((section) => section.size > 0).map(async (section) => {
      const page = await read({ protocol: 2, consumer: "agent-tool", federationTarget,
        query: { kind: "star-map", filters: { pinned: section.pinned } }, pageSize: section.size });
      if (page.protocol !== 2 || page.unchanged) throw new Error("The owning instance did not provide a monitor row page.");
      return page.entries.map((entry) => entry.row);
    }));
    return { kind: "bounded-monitor", threads: pages.flat() };
  }

  private async renderMonitorStatus(
    binding: MessagingBindingRecord,
    render: MessagingDeliveryGuard,
    event?: MessagingInboundEvent,
  ): Promise<MessagingBindingRecord | undefined> {
    if (render.isCancelled()) return undefined;
    const snapshot = await this.readMonitorRows(binding.monitor, federationTargetForBinding(binding));
    const now = this.context.now();
    const countsAsActivity = event !== undefined;
    const activeTurns = await this.resolveMonitorActiveTurns(snapshot, binding.monitor, countsAsActivity);
    const snippetsByThreadKey = await this.resolveMonitorSnippets(snapshot, binding.monitor, countsAsActivity);
    if (render.isCancelled()) return undefined;
    const intent = buildMonitorStatusIntent({
      activeTurnsByThreadKey: activeTurns,
      binding,
      capabilityProfile: this.context.capabilityProfile,
      createdAt: now,
      id: this.context.host().newIntentId("monitor"),
      navigation: snapshot,
      snippetsByThreadKey,
      topicControls: this.supportsMonitorTopicControls(event?.channel ?? binding.channel),
    });
    const result = await this.context.host().deliver(intent, binding, event, render);
    const currentBinding = await this.readCurrentBindingMonitor(binding, render);
    if (!currentBinding?.monitor || render.isCancelled()) return undefined;
    return await this.context.store.upsertBinding({
      ...currentBinding,
      monitor: {
        ...currentBinding.monitor,
        lastRenderedAt: now,
        updatedAt: now,
      },
      monitorSurface:
        result.surface && result.outcome !== "failed"
          ? result.surface
          : currentBinding.monitorSurface,
      updatedAt: now,
    });
  }

  private async renderChannelMonitorStatus(
    subscription: MessagingMonitorSubscriptionRecord,
    render: MessagingDeliveryGuard,
    event?: MessagingInboundEvent,
  ): Promise<MessagingMonitorSubscriptionRecord | undefined> {
    if (render.isCancelled()) return undefined;
    const snapshot = await this.readMonitorRows(subscription.monitor);
    const now = this.context.now();
    const countsAsActivity = event !== undefined;
    const activeTurns = await this.resolveMonitorActiveTurns(
      snapshot,
      subscription.monitor,
      countsAsActivity,
    );
    const snippetsByThreadKey = await this.resolveMonitorSnippets(
      snapshot,
      subscription.monitor,
      countsAsActivity,
    );
    if (render.isCancelled()) return undefined;
    const intent = {
      ...buildMonitorStatusIntent({
        activeTurnsByThreadKey: activeTurns,
        bindingId: subscription.id,
        capabilityProfile: this.context.capabilityProfile,
        createdAt: now,
        id: this.context.host().newIntentId("monitor"),
        monitor: subscription.monitor,
        monitorSurface: subscription.monitorSurface,
        navigation: snapshot,
        snippetsByThreadKey,
        topicControls: this.supportsMonitorTopicControls(event?.channel ?? subscription.channel),
      }),
      allowedActorIds: subscription.authorizedActorIds,
      ...(event
        ? {}
        : {
            audit: buildMessagingAuditContext({
              action: "monitor.deliver",
              actor: {
                platformUserId: subscription.authorizedActorIds[0] ?? "unknown",
              },
              bindingId: subscription.id,
              channel: subscription.channel,
              now,
            }),
          }),
    };
    const result = await this.context.host().deliver(intent, undefined, event, render);
    const current = await this.readCurrentChannelMonitor(subscription, render);
    if (!current || render.isCancelled()) return undefined;

    if (isPermanentMessagingTargetFailure(result)) {
      await this.context.store.revokeMonitorSubscription({
        subscriptionId: current.id,
        revokedAt: this.context.now(),
      });
      return undefined;
    }

    return await this.context.store.upsertMonitorSubscription({
      ...current,
      monitor: {
        ...current.monitor,
        lastRenderedAt: now,
        updatedAt: now,
      },
      monitorSurface:
        result.surface && result.outcome !== "failed"
          ? result.surface
          : current.monitorSurface,
      updatedAt: now,
    });
  }

  private async readCurrentBindingMonitor(
    binding: MessagingBindingRecord,
    render: MessagingDeliveryGuard,
  ): Promise<MessagingBindingRecord | undefined> {
    if (render.isCancelled()) return undefined;
    const latest = await this.context.store.getBinding(binding.id);
    if (
      latest?.monitor?.enabled
      && latest.revokedAt === undefined
      && latest.createdAt === binding.createdAt
      && latest.monitor.updatedAt === binding.monitor?.updatedAt
    ) {
      return latest;
    }
    return undefined;
  }

  private async readCurrentChannelMonitor(
    subscription: MessagingMonitorSubscriptionRecord,
    render: MessagingDeliveryGuard,
  ): Promise<MessagingMonitorSubscriptionRecord | undefined> {
    if (render.isCancelled()) return undefined;
    const latest = await this.context.store.findActiveMonitorSubscriptionForChannel(subscription.channel);
    if (
      latest?.monitor.enabled
      && latest.revokedAt === undefined
      && latest.id === subscription.id
      && latest.createdAt === subscription.createdAt
      && latest.monitor.updatedAt === subscription.monitor.updatedAt
    ) {
      return latest;
    }
    return undefined;
  }

  private async withMonitorRender<T>(
    key: string,
    run: (render: MessagingDeliveryGuard) => Promise<T>,
  ): Promise<T> {
    // The command or tick owns delivery, settlement and rearming for this render.
    // A newer command can invalidate that ownership even within the same millisecond.
    this.monitorRenders.get(key)?.cancel();
    const cancelled = Promise.withResolvers<void>();
    let active = true;
    const render: MessagingCancellationSignal = {
      isCancelled: () => !active || this.context.disposed,
      whenCancelled: cancelled.promise,
      cancel: () => {
        active = false;
        cancelled.resolve();
      },
    };
    this.monitorRenders.set(key, render);
    try {
      return await run(render);
    } finally {
      if (this.monitorRenders.get(key) === render) this.monitorRenders.delete(key);
    }
  }

  scheduleMonitorTick(binding: MessagingBindingRecord): void {
    if (
      this.context.disposed ||
      binding.revokedAt ||
      !binding.monitor?.enabled ||
      this.monitorTimersByBindingId.has(binding.id)
    ) {
      return;
    }

    const intervalMs = binding.monitor.intervalMs || MESSAGING_MONITOR_INTERVAL_MS;
    const timer = setTimeout(() => {
      this.monitorTimersByBindingId.delete(binding.id);
      void this.runMonitorTick(binding.id);
    }, intervalMs);
    this.monitorTimersByBindingId.set(binding.id, timer);
  }

  scheduleMonitorSubscriptionTick(
    subscription: MessagingMonitorSubscriptionRecord,
  ): void {
    if (
      this.context.disposed ||
      !this.context.host().isChannelInScope(subscription.channel) ||
      subscription.revokedAt ||
      !subscription.monitor.enabled ||
      this.monitorTimersBySubscriptionId.has(subscription.id)
    ) {
      return;
    }

    const intervalMs =
      subscription.monitor.intervalMs || MESSAGING_MONITOR_INTERVAL_MS;
    const timer = setTimeout(() => {
      this.monitorTimersBySubscriptionId.delete(subscription.id);
      void this.runMonitorSubscriptionTick(subscription);
    }, intervalMs);
    this.monitorTimersBySubscriptionId.set(subscription.id, timer);
  }

  clearMonitorTimer(bindingId: string): void {
    const timer = this.monitorTimersByBindingId.get(bindingId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.monitorTimersByBindingId.delete(bindingId);
  }

  clearMonitorSubscriptionTimer(subscriptionId: string): void {
    const timer = this.monitorTimersBySubscriptionId.get(subscriptionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.monitorTimersBySubscriptionId.delete(subscriptionId);
  }

  async runMonitorTick(bindingId: string): Promise<void> {
    const key = `binding:${bindingId}`;
    if (this.context.disposed || this.monitorRenders.has(key)) return;
    await this.withMonitorRender(key, async (render) => {
      const binding = await this.context.store.getBinding(bindingId);
      if (!binding?.monitor?.enabled || binding.revokedAt !== undefined || render.isCancelled()) return;
      let latest: MessagingBindingRecord | undefined;
      try {
        latest = await this.renderMonitorStatus(binding, render);
      } catch (error) {
        this.context.logger.debug?.("messaging monitor tick failed", {
          bindingId,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
        latest = await this.readCurrentBindingMonitor(binding, render);
      }
      if (latest && !render.isCancelled()) this.scheduleMonitorTick(latest);
    });
  }

  async runMonitorSubscriptionTick(scheduled: MessagingMonitorSubscriptionRecord): Promise<void> {
    const subscriptionId = scheduled.id;
    const key = channelMonitorRenderKey(scheduled.channel);
    if (this.context.disposed || !this.context.host().isChannelInScope(scheduled.channel) || this.monitorRenders.has(key)) return;
    await this.withMonitorRender(key, async (render) => {
      const subscription = await this.context.store.findActiveMonitorSubscriptionForChannel(scheduled.channel);
      if (
        subscription?.id !== subscriptionId
        || subscription.revokedAt !== undefined
        || !subscription.monitor.enabled
        || render.isCancelled()
      ) return;
      let latest: MessagingMonitorSubscriptionRecord | undefined;
      try {
        latest = await this.renderChannelMonitorStatus(subscription, render);
      } catch (error) {
        this.context.logger.debug?.("messaging channel monitor tick failed", {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId,
        });
        latest = await this.readCurrentChannelMonitor(subscription, render);
      }
      if (latest && !render.isCancelled()) this.scheduleMonitorSubscriptionTick(latest);
    });
  }

  async resolveMonitorActiveTurns(
    navigation: MessagingMonitorNavigation,
    monitor?: MessagingMonitorState,
    countsAsActivity = true,
  ): Promise<ReadonlyMap<string, MessagingActiveTurnSummary>> {
    const activeTurns = new Map(this.context.turns.snapshot());
    if (!this.context.backend.readThreadStatus) {
      return activeTurns;
    }

    const threads = selectMonitorThreads({ monitor, navigation }).threads;
    await Promise.all(
      threads.map(async (thread) => {
        const threadKey = threadKeyForNavigationThread(thread);
        const existing = activeTurns.get(threadKey);
        try {
          const status = await this.context.backend.readThreadStatus?.({
            backend: thread.source,
            federationTarget: federationTargetForThread(thread),
            threadId: thread.id,
            ...(countsAsActivity ? {} : { countsAsActivity: false }),
          });
          if (status === "active") {
            activeTurns.set(threadKey, {
              status: existing?.status === "waiting" ? "waiting" : "working",
              turnId: existing?.turnId ?? `${threadKey}:monitor`,
              updatedAt: this.context.now(),
            });
          } else if (
            status === "idle" &&
            existing &&
            (existing.status === "working" || existing.status === "waiting")
          ) {
            activeTurns.set(threadKey, {
              ...existing,
              status: "completed",
              updatedAt: this.context.now(),
            });
          }
        } catch (error) {
          this.context.logger.debug?.("messaging monitor thread status read failed", {
            backend: thread.source,
            error: error instanceof Error ? error.message : String(error),
            threadId: thread.id,
          });
        }
      }),
    );
    return activeTurns;
  }

  async resolveMonitorSnippets(
    navigation: MessagingMonitorNavigation,
    monitor?: MessagingMonitorState,
    countsAsActivity = true,
  ): Promise<ReadonlyMap<string, string>> {
    const snippets = new Map<string, string>();
    if (
      monitor?.showLastResponseSnippet !== true ||
      !this.context.backend.readThreadLastAssistantMessage
    ) {
      return snippets;
    }

    const threads = selectMonitorThreads({ monitor, navigation }).threads;
    await Promise.all(
      threads.map(async (thread) => {
        const threadKey = threadKeyForNavigationThread(thread);
        try {
          const text =
            await this.context.backend.readThreadLastAssistantMessage?.({
              backend: thread.source,
              federationTarget: federationTargetForThread(thread),
              threadId: thread.id,
              ...(countsAsActivity ? {} : { countsAsActivity: false }),
            });
          const trimmed = text?.trim();
          if (trimmed) {
            snippets.set(threadKey, trimmed);
          }
        } catch (error) {
          this.context.logger.debug?.("messaging monitor thread snippet read failed", {
            backend: thread.source,
            error: error instanceof Error ? error.message : String(error),
            threadId: thread.id,
          });
        }
      }),
    );
    return snippets;
  }

  async resolveMonitorBackendKinds(): Promise<AppServerBackendKind[]> {
    const listed = await this.context.backend.listBackends?.({
      includeUnavailable: true,
    });
    if (listed?.backends.length) {
      return [...new Set(listed.backends.map((backend) => backend.kind))];
    }
    return ["codex"];
  }
}

function channelMonitorRenderKey(channel: MessagingChannelRef): string {
  return `subscription:${buildMessagingConversationKey(channel)}`;
}
