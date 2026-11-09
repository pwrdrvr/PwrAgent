import type { MessagingStorage, MessagingStorageRecords } from "@pwragent/owner-core/messaging-storage";
import { federatedThreadIdentityKey, type FederatedThreadRef } from "@pwragent/shared";
import type { StateDb } from "./state-db.js";

type TimedRecord = { id: string; createdAt: number; updatedAt: number };
type RevocableRecord = TimedRecord & { revokedAt?: number };

/** Only fields used by persistence and retained queries; domain payloads stay host-owned. */
export interface SqliteMessagingStorageRecords<Records extends MessagingStorageRecords> extends MessagingStorageRecords {
  channel: { channel: string; conversation: { id: string; kind: string } };
  binding: RevocableRecord & {
    backend: string | undefined;
    threadId: string;
    channel: Records["channel"];
    federatedThread?: FederatedThreadRef;
  };
  bindingMetadataUpdate: { bindingId: string };
  bindingMetadataMerge: { binding: Records["binding"]; changed: boolean };
  observedSurface: { channel: Records["channel"]; firstSeenAt: number; lastSeenAt: number };
  defaultAgentScope: { kind: string };
  defaultAgentAssignment: RevocableRecord & {
    scope: Records["defaultAgentScope"];
    target: { backend: string; threadId: string };
  };
  monitorSubscription: RevocableRecord & { channel: Records["channel"] };
  managedTopic: TimedRecord & { channel: string; supergroupId: string; topicId: string; lifecycle: string };
  managedTopicObservationMerge: { topic: Records["managedTopic"]; changed: boolean };
  threadTopicLink: TimedRecord & { channel: string; supergroupId: string; backend: string; threadId: string; topicRecordId: string };
  topicCleanupProposal: TimedRecord & { channel: string; supergroupId: string; status: string; appliedAt?: number; expiresAt?: number };
  pendingIntent: {
    id: string; bindingId?: string; channel?: Records["channel"]; createdAt: number; expiresAt: number; allowedActorIds: string[];
    intent: { requestContext?: { backend: string; threadId: string; requestId: string } };
  };
  browseSession: TimedRecord & { bindingId?: string; channel: Records["channel"]; expiresAt: number; allowedActorIds: string[] };
  callbackHandle: TimedRecord & {
    bindingId?: string; browseSessionId?: string; channel: Records["channel"]; expiresAt: number; allowedActorIds: string[]; handle: string;
  };
  delivery: { id: string; bindingId?: string; deliveredAt?: number };
}

export type SqliteMessagingSnapshot<Records extends MessagingStorageRecords> = {
  bindings: Record<string, Records["binding"]>;
  defaultAgentAssignments: Record<string, Records["defaultAgentAssignment"]>;
  monitorSubscriptions: Record<string, Records["monitorSubscription"]>;
  topics: Record<string, Records["managedTopic"]>;
  topicLinks: Record<string, Records["threadTopicLink"]>;
  topicCleanupProposals: Record<string, Records["topicCleanupProposal"]>;
  pendingIntents: Record<string, Records["pendingIntent"]>;
  browseSessions: Record<string, Records["browseSession"]>;
  callbackHandles: Record<string, Records["callbackHandle"]>;
  deliveries: Record<string, Records["delivery"]>;
};

/** Hosts supply channel/domain policy without giving it a database handle. */
export interface SqliteMessagingPolicy<Records extends SqliteMessagingStorageRecords<Records>> {
  sanitizeBinding(value: Records["binding"]): Records["binding"];
  sanitizeDefaultAgentAssignment(value: Records["defaultAgentAssignment"]): Records["defaultAgentAssignment"];
  sanitizeMonitorSubscription(value: Records["monitorSubscription"]): Records["monitorSubscription"];
  sanitizeManagedTopic(value: Records["managedTopic"]): Records["managedTopic"];
  sanitizePendingIntent(value: Records["pendingIntent"]): Records["pendingIntent"];
  sanitizeBrowseSession(value: Records["browseSession"]): Records["browseSession"];
  sanitizeCallbackHandle(value: Records["callbackHandle"]): Records["callbackHandle"];
  sanitizeDelivery(value: Records["delivery"]): Records["delivery"];
  buildMessagingConversationKey(channel: Records["channel"]): string;
  buildMessagingConversationLookupKeys(channel: Records["channel"]): string[];
  buildChannelId(channel: Records["channel"]): string;
  buildMessagingDefaultAgentScopeKey(scope: Records["defaultAgentScope"]): string;
  buildDefaultAgentScopeLookup(channel: Records["channel"]): Array<{ key: string }>;
  channelKindForDefaultAgentScope(scope: Records["defaultAgentScope"]): string | null;
  parseDefaultAgentAssignment(payload: string): Records["defaultAgentAssignment"] | undefined;
  mergeMessagingBindingChannelMetadata(current: Records["binding"] | undefined, update: Records["bindingMetadataUpdate"]): Records["bindingMetadataMerge"] | undefined;
  mergeMessagingManagedTopicObservation(current: Records["managedTopic"] | undefined, observation: Records["managedTopic"]): Records["managedTopicObservationMerge"];
  isBindingForThread(binding: Records["binding"], params: Pick<Records["binding"], "backend" | "threadId">): boolean;
  isAsyncQuestionnaireForThread(intent: Records["pendingIntent"], params: Pick<Records["binding"], "backend" | "threadId">): boolean;
  observeSurface(current: Records["observedSurface"] | undefined, channel: Records["channel"], observedAt: number): Records["observedSurface"];
  bindingMetadataResult(binding: Records["binding"], changed: boolean): Records["bindingMetadataMerge"];
  managedTopicResult(topic: Records["managedTopic"], changed: boolean): Records["managedTopicObservationMerge"];
  snapshot(records: SqliteMessagingSnapshot<Records>): Records["snapshot"];
}

export class SqliteMessagingStore<Records extends SqliteMessagingStorageRecords<Records>> implements MessagingStorage<Records> {
  constructor(
    private readonly stateDb: StateDb,
    private readonly policy: SqliteMessagingPolicy<Records>,
  ) {}

  async upsertBinding(
    binding: Records["binding"],
  ): Promise<Records["binding"]> {
    const sanitized = this.policy.sanitizeBinding(binding);
    const channel = sanitized.channel;
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO bindings(binding_id, channel_kind, channel_id, thread_id, status, created_at, updated_at, revoked_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        channel.channel,
        this.policy.buildChannelId(channel),
        sanitized.threadId,
        sanitized.revokedAt ? "revoked" : "active",
        sanitized.createdAt,
        sanitized.updatedAt,
        sanitized.revokedAt ?? null,
        JSON.stringify(sanitized),
      );
    if (!sanitized.revokedAt) {
      await this.upsertObservedSurface(sanitized.channel, sanitized.updatedAt);
    }
    return structuredClone(sanitized);
  }

  async mergeBindingChannelMetadata(
    update: Records["bindingMetadataUpdate"],
  ): Promise<Records["bindingMetadataMerge"] | undefined> {
    const merge = this.stateDb.raw.transaction(() => {
      const row = this.stateDb.raw
        .prepare("SELECT payload FROM bindings WHERE binding_id = ?")
        .get(update.bindingId) as { payload: string } | undefined;
      const merged = this.policy.mergeMessagingBindingChannelMetadata(
        row
          ? JSON.parse(row.payload) as Records["binding"]
          : undefined,
        update,
      );
      if (!merged || !merged.changed) {
        return merged;
      }
      const sanitized = this.policy.sanitizeBinding(merged.binding);
      const channel = sanitized.channel;
      this.stateDb.raw
        .prepare(
          `INSERT OR REPLACE INTO bindings(binding_id, channel_kind, channel_id, thread_id, status, created_at, updated_at, revoked_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sanitized.id,
          channel.channel,
          this.policy.buildChannelId(channel),
          sanitized.threadId,
          sanitized.revokedAt ? "revoked" : "active",
          sanitized.createdAt,
          sanitized.updatedAt,
          sanitized.revokedAt ?? null,
          JSON.stringify(sanitized),
        );
      return this.policy.bindingMetadataResult(sanitized, true);
    });
    const merged = merge();
    if (merged?.changed && !merged.binding.revokedAt) {
      await this.upsertObservedSurface(
        merged.binding.channel,
        merged.binding.updatedAt,
      );
    }
    return merged
      ? this.policy.bindingMetadataResult(structuredClone(merged.binding), merged.changed)
      : undefined;
  }

  async getBinding(id: string): Promise<Records["binding"] | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM bindings WHERE binding_id = ?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async upsertObservedSurface(
    channel: Records["channel"],
    observedAt = Date.now(),
  ): Promise<Records["observedSurface"]> {
    const surfaceKey = this.policy.buildMessagingConversationKey(channel);
    const row = this.stateDb.raw
      .prepare(
        "SELECT payload FROM messaging_observed_surfaces WHERE surface_key = ?",
      )
      .get(surfaceKey) as { payload: string } | undefined;
    const current = row
      ? JSON.parse(row.payload) as Records["observedSurface"]
      : undefined;
    const record = this.policy.observeSurface(current, channel, observedAt);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO messaging_observed_surfaces(surface_key, channel_kind, conversation_kind, conversation_id, first_seen_at, last_seen_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        surfaceKey,
        record.channel.channel,
        record.channel.conversation.kind,
        record.channel.conversation.id,
        record.firstSeenAt,
        record.lastSeenAt,
        JSON.stringify(record),
      );
    return structuredClone(record);
  }

  async findObservedSurfaces(): Promise<Records["observedSurface"][]> {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM messaging_observed_surfaces ORDER BY last_seen_at DESC, surface_key ASC",
      )
      .all() as { payload: string }[];
    return rows.map((row) => (
      structuredClone(JSON.parse(row.payload) as Records["observedSurface"])
    ));
  }

  async upsertDefaultAgentAssignment(
    assignment: Records["defaultAgentAssignment"],
  ): Promise<Records["defaultAgentAssignment"]> {
    const sanitized = this.policy.sanitizeDefaultAgentAssignment(assignment);
    const scopeKey = this.policy.buildMessagingDefaultAgentScopeKey(sanitized.scope);
    const now = sanitized.updatedAt;
    const upsertAssignment = this.stateDb.raw.prepare(
      `INSERT OR REPLACE INTO messaging_default_agent_assignments(assignment_id, scope_kind, scope_key, channel_kind, backend, thread_id, status, created_at, updated_at, revoked_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsert = this.stateDb.raw.transaction(() => {
      const rowsToRevoke = sanitized.revokedAt
        ? []
        : this.stateDb.raw
            .prepare(
              "SELECT assignment_id, payload FROM messaging_default_agent_assignments WHERE status = 'active' AND scope_key = ? AND assignment_id != ?",
            )
            .all(scopeKey, sanitized.id) as {
              assignment_id: string;
              payload: string;
            }[];
      for (const row of rowsToRevoke) {
        try {
          const current = this.policy.parseDefaultAgentAssignment(row.payload);
          if (!current) {
            throw new Error("Invalid default Agent assignment payload");
          }
          const revoked: Records["defaultAgentAssignment"] = {
            ...current,
            revokedAt: now,
            updatedAt: now,
          };
          upsertAssignment.run(
            revoked.id,
            revoked.scope.kind,
            this.policy.buildMessagingDefaultAgentScopeKey(revoked.scope),
            this.policy.channelKindForDefaultAgentScope(revoked.scope),
            revoked.target.backend,
            revoked.target.threadId,
            "revoked",
            revoked.createdAt,
            revoked.updatedAt,
            revoked.revokedAt ?? null,
            JSON.stringify(revoked),
          );
        } catch {
          this.stateDb.raw
            .prepare(
              "UPDATE messaging_default_agent_assignments SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE assignment_id = ?",
            )
            .run(now, now, row.assignment_id);
        }
      }

      upsertAssignment.run(
        sanitized.id,
        sanitized.scope.kind,
        scopeKey,
        this.policy.channelKindForDefaultAgentScope(sanitized.scope),
        sanitized.target.backend,
        sanitized.target.threadId,
        sanitized.revokedAt ? "revoked" : "active",
        sanitized.createdAt,
        sanitized.updatedAt,
        sanitized.revokedAt ?? null,
        JSON.stringify(sanitized),
      );
    });
    upsert();

    return structuredClone(sanitized);
  }

  async getDefaultAgentAssignment(
    id: string,
  ): Promise<Records["defaultAgentAssignment"] | undefined> {
    const row = this.stateDb.raw
      .prepare(
        "SELECT payload FROM messaging_default_agent_assignments WHERE assignment_id = ?",
      )
      .get(id) as { payload: string } | undefined;
    return row ? this.policy.parseDefaultAgentAssignment(row.payload) : undefined;
  }

  async findActiveDefaultAgentAssignmentForChannel(
    channel: Records["channel"],
  ): Promise<Records["defaultAgentAssignment"] | undefined> {
    return (await this.findActiveDefaultAgentAssignmentsForChannel(channel))[0];
  }

  async findActiveDefaultAgentAssignments(): Promise<
    Records["defaultAgentAssignment"][]
  > {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM messaging_default_agent_assignments WHERE status = 'active' ORDER BY updated_at DESC, created_at DESC",
      )
      .all() as { payload: string }[];
    return rows
      .map((row) => this.policy.parseDefaultAgentAssignment(row.payload))
      .filter((assignment) => assignment !== undefined)
      .filter((assignment) => !assignment.revokedAt)
      .map((assignment) => structuredClone(assignment));
  }

  async findActiveDefaultAgentAssignmentsForChannel(
    channel: Records["channel"],
  ): Promise<Records["defaultAgentAssignment"][]> {
    const matches: Records["defaultAgentAssignment"][] = [];
    for (const { key: scopeKey } of this.policy.buildDefaultAgentScopeLookup(channel)) {
      const rows = this.stateDb.raw
        .prepare(
          "SELECT payload FROM messaging_default_agent_assignments WHERE status = 'active' AND scope_key = ? ORDER BY updated_at DESC, created_at DESC",
        )
        .all(scopeKey) as { payload: string }[];
      const match = rows
        .map((row) => this.policy.parseDefaultAgentAssignment(row.payload))
        .filter((assignment) => assignment !== undefined)
        .find((assignment) => !assignment.revokedAt);
      if (match) matches.push(match);
    }
    return matches;
  }

  async findActiveDefaultAgentAssignmentForScope(
    scope: Records["defaultAgentScope"],
  ): Promise<Records["defaultAgentAssignment"] | undefined> {
    const row = this.stateDb.raw
      .prepare(
        "SELECT payload FROM messaging_default_agent_assignments WHERE status = 'active' AND scope_key = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1",
      )
      .get(this.policy.buildMessagingDefaultAgentScopeKey(scope)) as
        | { payload: string }
        | undefined;
    if (!row) return undefined;
    const assignment = this.policy.parseDefaultAgentAssignment(row.payload);
    if (!assignment) return undefined;
    return assignment.revokedAt ? undefined : assignment;
  }

  async revokeDefaultAgentAssignment(params: {
    assignmentId: string;
    revokedAt?: number;
  }): Promise<Records["defaultAgentAssignment"] | undefined> {
    const current = await this.getDefaultAgentAssignment(params.assignmentId);
    if (!current) return undefined;
    const revokedAt = params.revokedAt ?? Date.now();
    const revoked: Records["defaultAgentAssignment"] = {
      ...current,
      revokedAt,
      updatedAt: revokedAt,
    };
    await this.upsertDefaultAgentAssignment(revoked);
    return structuredClone(revoked);
  }

  async revokeDefaultAgentAssignmentsForTarget(params: {
    backend: Records["defaultAgentAssignment"]["target"]["backend"];
    threadId: Records["defaultAgentAssignment"]["target"]["threadId"];
    revokedAt?: number;
  }): Promise<Records["defaultAgentAssignment"][]> {
    const revokedAt = params.revokedAt ?? Date.now();
    const revoke = this.stateDb.raw.transaction(() => {
      const rows = this.stateDb.raw
        .prepare(
          "SELECT payload FROM messaging_default_agent_assignments WHERE status = 'active' AND backend = ? AND thread_id = ?",
        )
        .all(params.backend, params.threadId) as { payload: string }[];
      const revoked: Records["defaultAgentAssignment"][] = [];
      for (const row of rows) {
        const current = this.policy.parseDefaultAgentAssignment(row.payload);
        if (!current) continue;
        const next = {
          ...current,
          revokedAt,
          updatedAt: revokedAt,
        };
        this.writeDefaultAgentAssignment(next);
        revoked.push(next);
      }
      return revoked;
    });
    return revoke().map((assignment) => structuredClone(assignment));
  }

  private writeDefaultAgentAssignment(
    assignment: Records["defaultAgentAssignment"],
  ): void {
    const scopeKey = this.policy.buildMessagingDefaultAgentScopeKey(assignment.scope);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO messaging_default_agent_assignments(assignment_id, scope_kind, scope_key, channel_kind, backend, thread_id, status, created_at, updated_at, revoked_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assignment.id,
        assignment.scope.kind,
        scopeKey,
        this.policy.channelKindForDefaultAgentScope(assignment.scope),
        assignment.target.backend,
        assignment.target.threadId,
        assignment.revokedAt ? "revoked" : "active",
        assignment.createdAt,
        assignment.updatedAt,
        assignment.revokedAt ?? null,
        JSON.stringify(assignment),
      );
  }

  async findActiveBindingForChannel(
    channel: Records["channel"],
  ): Promise<Records["binding"] | undefined> {
    const channelKeys = this.policy.buildMessagingConversationLookupKeys(channel);
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM bindings WHERE status = 'active' AND channel_kind = ?",
      )
      .all(channel.channel) as { payload: string }[];
    const bindings = rows
      .map((row) => JSON.parse(row.payload) as Records["binding"])
      .filter((binding) => !binding.revokedAt);
    for (const channelKey of channelKeys) {
      for (const binding of bindings) {
        if (this.policy.buildMessagingConversationKey(binding.channel) === channelKey) {
          return binding;
        }
      }
    }
    return undefined;
  }

  async findActiveBindings(): Promise<Records["binding"][]> {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM bindings WHERE status = 'active' ORDER BY updated_at DESC, created_at DESC",
      )
      .all() as { payload: string }[];
    // JSON.parse already returns fresh objects that no caller shares.
    return rows
      .map((row) => JSON.parse(row.payload) as Records["binding"])
      .filter((binding) => !binding.revokedAt);
  }

  async findActiveBindingsForThread(params: {
    backend: Records["binding"]["backend"];
    threadId: Records["binding"]["threadId"];
  }): Promise<Records["binding"][]> {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM bindings WHERE status = 'active' AND thread_id = ?",
      )
      .all(params.threadId) as { payload: string }[];
    return rows
      .map((row) => JSON.parse(row.payload) as Records["binding"])
      .filter((binding) => !binding.revokedAt && this.policy.isBindingForThread(binding, params));
  }

  async findActiveBindingsForFederatedThread(
    ref: FederatedThreadRef,
  ): Promise<Records["binding"][]> {
    const wanted = federatedThreadIdentityKey(ref);
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM bindings WHERE status = 'active' AND thread_id = ?",
      )
      .all(ref.threadId) as { payload: string }[];
    return rows
      .map((row) => JSON.parse(row.payload) as Records["binding"])
      .filter((binding) => {
        if (binding.revokedAt || !binding.federatedThread) return false;
        return federatedThreadIdentityKey(binding.federatedThread) === wanted;
      });
  }

  async findActiveBindingsForBackend(params: {
    backend: Records["binding"]["backend"];
  }): Promise<Records["binding"][]> {
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM bindings WHERE status = 'active'")
      .all() as { payload: string }[];
    return rows
      .map((row) => JSON.parse(row.payload) as Records["binding"])
      .filter((binding) => {
        if (binding.revokedAt) return false;
        if (!binding.backend) return true;
        return binding.backend === params.backend;
      });
  }

  async revokeBinding(params: {
    bindingId: string;
    revokedAt?: number;
  }): Promise<Records["binding"] | undefined> {
    const current = await this.getBinding(params.bindingId);
    if (!current) return undefined;

    const revokedAt = params.revokedAt ?? Date.now();
    const revoked: Records["binding"] = {
      ...current,
      revokedAt,
      updatedAt: revokedAt,
    };
    await this.upsertBinding(revoked);

    this.stateDb.raw
      .prepare("DELETE FROM pending_intents WHERE binding_id = ?")
      .run(params.bindingId);
    this.stateDb.raw
      .prepare("DELETE FROM browse_sessions WHERE binding_id = ?")
      .run(params.bindingId);
    await this.deletePendingIntentsForChannel({ channel: current.channel });
    await this.deleteCallbackHandlesForBinding({ bindingId: params.bindingId });

    return structuredClone(revoked);
  }

  async upsertMonitorSubscription(
    subscription: Records["monitorSubscription"],
  ): Promise<Records["monitorSubscription"]> {
    const sanitized = this.policy.sanitizeMonitorSubscription(subscription);
    const channel = sanitized.channel;
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO monitor_subscriptions(subscription_id, channel_kind, channel_id, status, created_at, updated_at, revoked_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        channel.channel,
        this.policy.buildChannelId(channel),
        sanitized.revokedAt ? "revoked" : "active",
        sanitized.createdAt,
        sanitized.updatedAt,
        sanitized.revokedAt ?? null,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getMonitorSubscription(
    id: string,
  ): Promise<Records["monitorSubscription"] | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM monitor_subscriptions WHERE subscription_id = ?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async findActiveMonitorSubscriptionForChannel(
    channel: Records["channel"],
  ): Promise<Records["monitorSubscription"] | undefined> {
    const channelKey = this.policy.buildMessagingConversationKey(channel);
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM monitor_subscriptions WHERE status = 'active' AND channel_kind = ?",
      )
      .all(channel.channel) as { payload: string }[];
    return rows
      .map((row) => JSON.parse(row.payload) as Records["monitorSubscription"])
      .filter(
        (subscription) =>
          !subscription.revokedAt &&
          this.policy.buildMessagingConversationKey(subscription.channel) === channelKey,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
  }

  async findActiveMonitorSubscriptionsForChannelKind(params: {
    channel: Records["channel"]["channel"];
  }): Promise<Records["monitorSubscription"][]> {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM monitor_subscriptions WHERE status = 'active' AND channel_kind = ?",
      )
      .all(params.channel) as { payload: string }[];
    return rows
      .map((row) => JSON.parse(row.payload) as Records["monitorSubscription"])
      .filter((subscription) => !subscription.revokedAt);
  }

  async revokeMonitorSubscription(params: {
    subscriptionId: string;
    revokedAt?: number;
  }): Promise<Records["monitorSubscription"] | undefined> {
    const current = await this.getMonitorSubscription(params.subscriptionId);
    if (!current) return undefined;

    const revokedAt = params.revokedAt ?? Date.now();
    const revoked: Records["monitorSubscription"] = {
      ...current,
      revokedAt,
      updatedAt: revokedAt,
    };
    await this.upsertMonitorSubscription(revoked);
    await this.deletePendingIntentsForChannel({ channel: current.channel });
    return structuredClone(revoked);
  }

  async upsertManagedTopic(
    topic: Records["managedTopic"],
  ): Promise<Records["managedTopic"]> {
    const sanitized = this.policy.sanitizeManagedTopic(topic);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO messaging_managed_topics(topic_record_id, channel_kind, supergroup_id, topic_id, status, created_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.channel,
        sanitized.supergroupId,
        sanitized.topicId,
        sanitized.lifecycle,
        sanitized.createdAt,
        sanitized.updatedAt,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async mergeManagedTopicObservation(
    observation: Records["managedTopic"],
  ): Promise<Records["managedTopicObservationMerge"]> {
    const sanitizedObservation = this.policy.sanitizeManagedTopic(observation);
    const merge = this.stateDb.raw.transaction(() => {
      const row = this.stateDb.raw
        .prepare(
          "SELECT payload FROM messaging_managed_topics WHERE topic_record_id = ?",
        )
        .get(sanitizedObservation.id) as { payload: string } | undefined;
      const merged = this.policy.mergeMessagingManagedTopicObservation(
        row
          ? JSON.parse(row.payload) as Records["managedTopic"]
          : undefined,
        sanitizedObservation,
      );
      if (!merged.changed) {
        return merged;
      }
      const sanitized = this.policy.sanitizeManagedTopic(merged.topic);
      this.stateDb.raw
        .prepare(
          `INSERT OR REPLACE INTO messaging_managed_topics(topic_record_id, channel_kind, supergroup_id, topic_id, status, created_at, updated_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sanitized.id,
          sanitized.channel,
          sanitized.supergroupId,
          sanitized.topicId,
          sanitized.lifecycle,
          sanitized.createdAt,
          sanitized.updatedAt,
          JSON.stringify(sanitized),
        );
      return this.policy.managedTopicResult(sanitized, true);
    });
    const merged = merge();
    return this.policy.managedTopicResult(structuredClone(merged.topic), merged.changed);
  }

  async getManagedTopic(
    id: string,
  ): Promise<Records["managedTopic"] | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM messaging_managed_topics WHERE topic_record_id = ?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async findManagedTopicsForSupergroup(params: {
    channel: Records["channel"]["channel"];
    supergroupId: string;
  }): Promise<Records["managedTopic"][]> {
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM messaging_managed_topics WHERE channel_kind = ? AND supergroup_id = ? ORDER BY updated_at DESC, created_at DESC",
      )
      .all(params.channel, params.supergroupId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as Records["managedTopic"]);
  }

  async findManagedTopicByConversation(params: {
    channel: Records["channel"]["channel"];
    supergroupId: string;
    topicId: string;
  }): Promise<Records["managedTopic"] | undefined> {
    const row = this.stateDb.raw
      .prepare(
        "SELECT payload FROM messaging_managed_topics WHERE channel_kind = ? AND supergroup_id = ? AND topic_id = ?",
      )
      .get(params.channel, params.supergroupId, params.topicId) as
      | { payload: string }
      | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async upsertThreadTopicLink(
    link: Records["threadTopicLink"],
  ): Promise<Records["threadTopicLink"]> {
    const sanitized = structuredClone(link);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO messaging_thread_topic_links(link_id, channel_kind, supergroup_id, backend, thread_id, topic_record_id, created_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.channel,
        sanitized.supergroupId,
        sanitized.backend,
        sanitized.threadId,
        sanitized.topicRecordId,
        sanitized.createdAt,
        sanitized.updatedAt,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async findThreadTopicLink(params: {
    backend: Records["threadTopicLink"]["backend"];
    channel: Records["channel"]["channel"];
    supergroupId: string;
    threadId: string;
  }): Promise<Records["threadTopicLink"] | undefined> {
    const row = this.stateDb.raw
      .prepare(
        "SELECT payload FROM messaging_thread_topic_links WHERE channel_kind = ? AND supergroup_id = ? AND backend = ? AND thread_id = ?",
      )
      .get(params.channel, params.supergroupId, params.backend, params.threadId) as
      | { payload: string }
      | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async upsertTopicCleanupProposal(
    proposal: Records["topicCleanupProposal"],
  ): Promise<Records["topicCleanupProposal"]> {
    const sanitized = structuredClone(proposal);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO messaging_topic_cleanup_proposals(proposal_id, channel_kind, supergroup_id, status, created_at, updated_at, applied_at, expires_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.channel,
        sanitized.supergroupId,
        sanitized.status,
        sanitized.createdAt,
        sanitized.updatedAt,
        sanitized.appliedAt ?? null,
        sanitized.expiresAt ?? null,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getTopicCleanupProposal(
    id: string,
  ): Promise<Records["topicCleanupProposal"] | undefined> {
    const row = this.stateDb.raw
      .prepare(
        "SELECT payload FROM messaging_topic_cleanup_proposals WHERE proposal_id = ?",
      )
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async upsertPendingIntent(
    pendingIntent: Records["pendingIntent"],
  ): Promise<Records["pendingIntent"]> {
    const sanitized = this.policy.sanitizePendingIntent(pendingIntent);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO pending_intents(intent_id, binding_id, created_at, expires_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.bindingId ?? "",
        sanitized.createdAt,
        sanitized.expiresAt,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getPendingIntent(
    id: string,
    options?: { now?: number },
  ): Promise<Records["pendingIntent"] | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM pending_intents WHERE intent_id = ?")
      .get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    const intent: Records["pendingIntent"] = JSON.parse(row.payload);
    if (intent.expiresAt <= (options?.now ?? Date.now())) return undefined;
    return intent;
  }

  async findActivePendingIntentForChannel(params: {
    actorId: string;
    channel: Records["channel"];
    now?: number;
  }): Promise<Records["pendingIntent"] | undefined> {
    const channelKey = this.policy.buildMessagingConversationKey(params.channel);
    const now = params.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM pending_intents WHERE expires_at > ?")
      .all(now) as { payload: string }[];
    const matches = rows
      .map((r) => JSON.parse(r.payload) as Records["pendingIntent"])
      .filter(
        (intent) =>
          intent.allowedActorIds.includes(params.actorId) &&
          intent.channel &&
          this.policy.buildMessagingConversationKey(intent.channel) === channelKey,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return matches[0];
  }

  async findActivePendingIntentsForRequest(params: {
    backend: Records["binding"]["backend"];
    threadId: Records["binding"]["threadId"];
    requestId: string;
    now?: number;
  }): Promise<Records["pendingIntent"][]> {
    const now = params.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM pending_intents WHERE expires_at > ?")
      .all(now) as { payload: string }[];
    return rows
      .map((r) => JSON.parse(r.payload) as Records["pendingIntent"])
      .filter((intent) => {
        const ctx = intent.intent.requestContext;
        return (
          ctx?.backend === params.backend &&
          ctx.threadId === params.threadId &&
          ctx.requestId === params.requestId
        );
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async findActivePendingAsyncQuestionnaires(params: {
    backend: Records["binding"]["backend"];
    threadId: Records["binding"]["threadId"];
    now?: number;
  }): Promise<Records["pendingIntent"][]> {
    const now = params.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare(
        "SELECT payload FROM pending_intents WHERE expires_at > ?"
        + " AND json_extract(payload, '$.intent.asyncReply.threadId') = ?",
      )
      .all(now, params.threadId) as { payload: string }[];
    return rows
      .map((r) => JSON.parse(r.payload) as Records["pendingIntent"])
      .filter((intent) => this.policy.isAsyncQuestionnaireForThread(intent, params))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async deletePendingIntent(id: string): Promise<void> {
    this.stateDb.raw
      .prepare("DELETE FROM pending_intents WHERE intent_id = ?")
      .run(id);
  }

  /**
   * Retire every channel-scoped pending intent on a channel that is
   * NOT tied to a specific binding. Used by `bindChannelToThread` to
   * clean up the resume browser's pending intent (and any other
   * pre-binding picker intent) the moment a successful bind lands —
   * otherwise the next inbound text on that channel matches the stale
   * picker intent and the bot bounces "Choose an option" instead of
   * routing to the new binding.
   *
   * Binding-scoped pending intents (binding_id != '') are kept — they
   * belong to the binding's status surface, approval flows, etc.
   */
  async deletePendingIntentsForChannel(params: {
    channel: Records["channel"];
  }): Promise<string[]> {
    const channelKey = this.policy.buildMessagingConversationKey(params.channel);
    // Only consider channel-only intents (binding_id stored as ''). The
    // matching channel ref is JSON-encoded inside the payload, so we
    // parse and compare in JS rather than wrestle with sqlite JSON
    // extraction. The pending_intents table is small (capped TTL,
    // pruned by GC) so this is cheap.
    const rows = this.stateDb.raw
      .prepare(
        "SELECT intent_id, payload FROM pending_intents WHERE binding_id = ''",
      )
      .all() as { intent_id: string; payload: string }[];
    const removed: string[] = [];
    for (const row of rows) {
      try {
        const record = JSON.parse(row.payload) as Records["pendingIntent"];
        if (
          record.channel &&
          this.policy.buildMessagingConversationKey(record.channel) === channelKey
        ) {
          removed.push(row.intent_id);
        }
      } catch {
        // Malformed payload — skip; the row will be cleaned up by GC
        // on its expiry.
      }
    }
    if (removed.length === 0) return [];
    const deleteIntent = this.stateDb.raw.prepare(
      "DELETE FROM pending_intents WHERE intent_id = ?",
    );
    const deleteIntents = this.stateDb.raw.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteIntent.run(id);
      }
    });
    deleteIntents(removed);
    return removed;
  }

  async deletePendingIntentsForThread(params: {
    backend: Records["binding"]["backend"];
    threadId: Records["binding"]["threadId"];
  }): Promise<string[]> {
    const bindingRows = this.stateDb.raw
      .prepare("SELECT payload FROM bindings WHERE thread_id = ?")
      .all(params.threadId) as { payload: string }[];
    const bindingIds = new Set<string>();
    for (const row of bindingRows) {
      try {
        const binding = JSON.parse(row.payload) as Records["binding"];
        if (!binding.backend || binding.backend === params.backend) {
          bindingIds.add(binding.id);
        }
      } catch {
        // Malformed binding payloads should not block intent cleanup.
      }
    }

    const rows = this.stateDb.raw
      .prepare("SELECT intent_id, binding_id, payload FROM pending_intents")
      .all() as { intent_id: string; binding_id: string; payload: string }[];
    const removed: string[] = [];
    for (const row of rows) {
      try {
        const intent = JSON.parse(row.payload) as Records["pendingIntent"];
        const requestContext = intent.intent.requestContext;
        if (
          (requestContext?.backend === params.backend &&
            requestContext.threadId === params.threadId) ||
          (row.binding_id && bindingIds.has(row.binding_id))
        ) {
          removed.push(row.intent_id);
        }
      } catch {
        // Malformed payloads are left for expiry cleanup.
      }
    }
    if (removed.length === 0) return [];

    const deleteIntent = this.stateDb.raw.prepare(
      "DELETE FROM pending_intents WHERE intent_id = ?",
    );
    const deleteIntents = this.stateDb.raw.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteIntent.run(id);
      }
    });
    deleteIntents(removed);
    return removed;
  }

  async cleanupExpiredPendingIntents(options?: {
    now?: number;
  }): Promise<string[]> {
    const now = options?.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare(
        "SELECT intent_id FROM pending_intents WHERE expires_at <= ?",
      )
      .all(now) as { intent_id: string }[];
    const removed = rows.map((r) => r.intent_id);
    if (removed.length > 0) {
      this.stateDb.raw
        .prepare("DELETE FROM pending_intents WHERE expires_at <= ?")
        .run(now);
    }
    return removed;
  }

  async upsertBrowseSession(
    browseSession: Records["browseSession"],
  ): Promise<Records["browseSession"]> {
    const sanitized = this.policy.sanitizeBrowseSession(browseSession);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO browse_sessions(session_id, binding_id, created_at, expires_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.bindingId ?? null,
        sanitized.createdAt,
        sanitized.expiresAt,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getBrowseSession(
    id: string,
    options?: { now?: number },
  ): Promise<Records["browseSession"] | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM browse_sessions WHERE session_id = ?")
      .get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    const session: Records["browseSession"] = JSON.parse(row.payload);
    if (session.expiresAt <= (options?.now ?? Date.now())) return undefined;
    return session;
  }

  async findActiveBrowseSessionForChannel(params: {
    actorId: string;
    channel: Records["channel"];
    now?: number;
  }): Promise<Records["browseSession"] | undefined> {
    const channelKey = this.policy.buildMessagingConversationKey(params.channel);
    const now = params.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM browse_sessions WHERE expires_at > ?")
      .all(now) as { payload: string }[];
    const matches = rows
      .map((r) => JSON.parse(r.payload) as Records["browseSession"])
      .filter(
        (session) =>
          session.allowedActorIds.includes(params.actorId) &&
          this.policy.buildMessagingConversationKey(session.channel) === channelKey,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return matches[0];
  }

  async deleteBrowseSession(id: string): Promise<void> {
    this.stateDb.raw
      .prepare("DELETE FROM browse_sessions WHERE session_id = ?")
      .run(id);
    this.stateDb.raw
      .prepare("DELETE FROM callback_handles WHERE session_id = ?")
      .run(id);
  }

  async cleanupExpiredBrowseSessions(options?: {
    now?: number;
  }): Promise<string[]> {
    const now = options?.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare(
        "SELECT session_id FROM browse_sessions WHERE expires_at <= ?",
      )
      .all(now) as { session_id: string }[];
    const removed = rows.map((r) => r.session_id);
    if (removed.length > 0) {
      this.stateDb.raw
        .prepare("DELETE FROM browse_sessions WHERE expires_at <= ?")
        .run(now);
      for (const sessionId of removed) {
        this.stateDb.raw
          .prepare("DELETE FROM callback_handles WHERE session_id = ?")
          .run(sessionId);
      }
    }
    return removed;
  }

  async upsertCallbackHandle(
    callbackHandle: Records["callbackHandle"],
  ): Promise<Records["callbackHandle"]> {
    const sanitized = this.policy.sanitizeCallbackHandle(callbackHandle);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO callback_handles(handle_id, session_id, created_at, expires_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.browseSessionId ?? null,
        sanitized.createdAt,
        sanitized.expiresAt,
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getCallbackHandle(
    id: string,
    options?: { now?: number },
  ): Promise<Records["callbackHandle"] | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM callback_handles WHERE handle_id = ?")
      .get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    const handle: Records["callbackHandle"] = JSON.parse(row.payload);
    if (handle.expiresAt <= (options?.now ?? Date.now())) return undefined;
    return handle;
  }

  async resolveCallbackHandle(params: {
    actorId: string;
    channel: Records["channel"];
    handle: string;
    now?: number;
  }): Promise<Records["callbackHandle"] | undefined> {
    const channelKey = this.policy.buildMessagingConversationKey(params.channel);
    const now = params.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM callback_handles WHERE expires_at > ?")
      .all(now) as { payload: string }[];
    const matches = rows
      .map((r) => JSON.parse(r.payload) as Records["callbackHandle"])
      .filter(
        (handle) =>
          handle.handle === params.handle &&
          handle.allowedActorIds.includes(params.actorId) &&
          this.policy.buildMessagingConversationKey(handle.channel) === channelKey,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return matches[0];
  }

  async deleteCallbackHandle(id: string): Promise<void> {
    this.stateDb.raw
      .prepare("DELETE FROM callback_handles WHERE handle_id = ?")
      .run(id);
  }

  async deleteCallbackHandlesForBinding(params: {
    bindingId: string;
  }): Promise<string[]> {
    const rows = this.stateDb.raw
      .prepare("SELECT handle_id, payload FROM callback_handles")
      .all() as { handle_id: string; payload: string }[];
    const removed: string[] = [];
    for (const row of rows) {
      try {
        const handle = JSON.parse(row.payload) as Records["callbackHandle"];
        if (handle.bindingId === params.bindingId) {
          removed.push(row.handle_id);
        }
      } catch {
        // Malformed payload — skip; the row will be cleaned up by GC
        // on its expiry.
      }
    }
    if (removed.length === 0) return [];
    const deleteHandle = this.stateDb.raw.prepare(
      "DELETE FROM callback_handles WHERE handle_id = ?",
    );
    const deleteHandles = this.stateDb.raw.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteHandle.run(id);
      }
    });
    deleteHandles(removed);
    return removed;
  }

  async cleanupExpiredCallbackHandles(options?: {
    now?: number;
  }): Promise<string[]> {
    const now = options?.now ?? Date.now();
    const rows = this.stateDb.raw
      .prepare(
        "SELECT handle_id FROM callback_handles WHERE expires_at <= ?",
      )
      .all(now) as { handle_id: string }[];
    const removed = rows.map((r) => r.handle_id);
    if (removed.length > 0) {
      this.stateDb.raw
        .prepare("DELETE FROM callback_handles WHERE expires_at <= ?")
        .run(now);
    }
    return removed;
  }

  async recordDelivery(
    delivery: Records["delivery"],
  ): Promise<Records["delivery"]> {
    const sanitized = this.policy.sanitizeDelivery(delivery);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO deliveries(delivery_id, binding_id, created_at, payload)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        sanitized.id,
        sanitized.bindingId ?? "",
        sanitized.deliveredAt ?? Date.now(),
        JSON.stringify(sanitized),
      );
    return structuredClone(sanitized);
  }

  async getDelivery(id: string): Promise<Records["delivery"] | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM deliveries WHERE delivery_id = ?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async readSnapshot(): Promise<Records["snapshot"]> {
    const bindings: Record<string, Records["binding"]> = Object.create(null);
    const defaultAgentAssignments: Record<
      string,
      Records["defaultAgentAssignment"]
    > = Object.create(null);
    const monitorSubscriptions: Record<string, Records["monitorSubscription"]> = Object.create(null);
    const pendingIntents: Record<string, Records["pendingIntent"]> = Object.create(null);
    const browseSessions: Record<string, Records["browseSession"]> = Object.create(null);
    const callbackHandles: Record<string, Records["callbackHandle"]> = Object.create(null);
    const deliveries: Record<string, Records["delivery"]> = Object.create(null);
    const topicCleanupProposals: Record<string, Records["topicCleanupProposal"]> = Object.create(null);
    const topicLinks: Record<string, Records["threadTopicLink"]> = Object.create(null);
    const topics: Record<string, Records["managedTopic"]> = Object.create(null);

    for (const row of this.stateDb.raw
      .prepare("SELECT binding_id, payload FROM bindings")
      .all() as { binding_id: string; payload: string }[]) {
      bindings[row.binding_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare(
        "SELECT assignment_id, payload FROM messaging_default_agent_assignments",
      )
      .all() as { assignment_id: string; payload: string }[]) {
      defaultAgentAssignments[row.assignment_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT subscription_id, payload FROM monitor_subscriptions")
      .all() as { subscription_id: string; payload: string }[]) {
      monitorSubscriptions[row.subscription_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT intent_id, payload FROM pending_intents")
      .all() as { intent_id: string; payload: string }[]) {
      pendingIntents[row.intent_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT session_id, payload FROM browse_sessions")
      .all() as { session_id: string; payload: string }[]) {
      browseSessions[row.session_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT handle_id, payload FROM callback_handles")
      .all() as { handle_id: string; payload: string }[]) {
      callbackHandles[row.handle_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT delivery_id, payload FROM deliveries")
      .all() as { delivery_id: string; payload: string }[]) {
      deliveries[row.delivery_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT topic_record_id, payload FROM messaging_managed_topics")
      .all() as { topic_record_id: string; payload: string }[]) {
      topics[row.topic_record_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT link_id, payload FROM messaging_thread_topic_links")
      .all() as { link_id: string; payload: string }[]) {
      topicLinks[row.link_id] = JSON.parse(row.payload);
    }
    for (const row of this.stateDb.raw
      .prepare("SELECT proposal_id, payload FROM messaging_topic_cleanup_proposals")
      .all() as { proposal_id: string; payload: string }[]) {
      topicCleanupProposals[row.proposal_id] = JSON.parse(row.payload);
    }

    return this.policy.snapshot({
      bindings,
      defaultAgentAssignments,
      monitorSubscriptions,
      topicCleanupProposals,
      topicLinks,
      topics,
      pendingIntents,
      browseSessions,
      callbackHandles,
      deliveries,
    });
  }
}

