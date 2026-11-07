import type { FederatedThreadRef } from "@pwragent/shared";

/** Hosts bind these opaque domain records without adding transport dependencies to owner policy. */
export interface MessagingStorageRecords {
  binding: { backend: unknown; threadId: unknown };
  bindingMetadataUpdate: unknown;
  bindingMetadataMerge: unknown;
  channel: { channel: unknown };
  observedSurface: unknown;
  defaultAgentAssignment: { target: { backend: unknown; threadId: unknown } };
  defaultAgentScope: unknown;
  monitorSubscription: unknown;
  managedTopic: unknown;
  managedTopicObservationMerge: unknown;
  threadTopicLink: { backend: unknown };
  topicCleanupProposal: unknown;
  pendingIntent: unknown;
  browseSession: unknown;
  callbackHandle: unknown;
  delivery: unknown;
  snapshot: unknown;
}

export interface MessagingStorage<Records extends MessagingStorageRecords> {
  upsertBinding(
    binding: Records["binding"],
  ): Promise<Records["binding"]>;

  mergeBindingChannelMetadata(
    update: Records["bindingMetadataUpdate"],
  ): Promise<Records["bindingMetadataMerge"] | undefined>;

  getBinding(id: string): Promise<Records["binding"] | undefined>;

  upsertObservedSurface(
    channel: Records["channel"],
    observedAt?: number,
  ): Promise<Records["observedSurface"]>;

  findObservedSurfaces(): Promise<Records["observedSurface"][]>;

  upsertDefaultAgentAssignment(
    assignment: Records["defaultAgentAssignment"],
  ): Promise<Records["defaultAgentAssignment"]>;

  getDefaultAgentAssignment(
    id: string,
  ): Promise<Records["defaultAgentAssignment"] | undefined>;

  findActiveDefaultAgentAssignmentForChannel(
    channel: Records["channel"],
  ): Promise<Records["defaultAgentAssignment"] | undefined>;

  findActiveDefaultAgentAssignments(): Promise<
    Records["defaultAgentAssignment"][]
  >;

  findActiveDefaultAgentAssignmentsForChannel(
    channel: Records["channel"],
  ): Promise<Records["defaultAgentAssignment"][]>;

  findActiveDefaultAgentAssignmentForScope(
    scope: Records["defaultAgentScope"],
  ): Promise<Records["defaultAgentAssignment"] | undefined>;

  revokeDefaultAgentAssignment(params: {
    assignmentId: string;
    revokedAt?: number;
  }): Promise<Records["defaultAgentAssignment"] | undefined>;

  revokeDefaultAgentAssignmentsForTarget(params: {
    backend: Records["defaultAgentAssignment"]["target"]["backend"];
    threadId: Records["defaultAgentAssignment"]["target"]["threadId"];
    revokedAt?: number;
  }): Promise<Records["defaultAgentAssignment"][]>;

  findActiveBindingForChannel(
    channel: Records["channel"],
  ): Promise<Records["binding"] | undefined>;

  findActiveBindings(): Promise<Records["binding"][]>;

  findActiveBindingsForThread(params: {
    backend: Records["binding"]["backend"];
    threadId: Records["binding"]["threadId"];
  }): Promise<Records["binding"][]>;

  findActiveBindingsForFederatedThread(
    ref: FederatedThreadRef,
  ): Promise<Records["binding"][]>;

  findActiveBindingsForBackend(params: {
    backend: Records["binding"]["backend"];
  }): Promise<Records["binding"][]>;

  revokeBinding(params: {
    bindingId: string;
    revokedAt?: number;
  }): Promise<Records["binding"] | undefined>;

  upsertMonitorSubscription(
    subscription: Records["monitorSubscription"],
  ): Promise<Records["monitorSubscription"]>;

  getMonitorSubscription(
    id: string,
  ): Promise<Records["monitorSubscription"] | undefined>;

  findActiveMonitorSubscriptionForChannel(
    channel: Records["channel"],
  ): Promise<Records["monitorSubscription"] | undefined>;

  findActiveMonitorSubscriptionsForChannelKind(params: {
    channel: Records["channel"]["channel"];
  }): Promise<Records["monitorSubscription"][]>;

  revokeMonitorSubscription(params: {
    subscriptionId: string;
    revokedAt?: number;
  }): Promise<Records["monitorSubscription"] | undefined>;

  upsertManagedTopic(
    topic: Records["managedTopic"],
  ): Promise<Records["managedTopic"]>;

  mergeManagedTopicObservation(
    observation: Records["managedTopic"],
  ): Promise<Records["managedTopicObservationMerge"]>;

  getManagedTopic(
    id: string,
  ): Promise<Records["managedTopic"] | undefined>;

  findManagedTopicsForSupergroup(params: {
    channel: Records["channel"]["channel"];
    supergroupId: string;
  }): Promise<Records["managedTopic"][]>;

  findManagedTopicByConversation(params: {
    channel: Records["channel"]["channel"];
    supergroupId: string;
    topicId: string;
  }): Promise<Records["managedTopic"] | undefined>;

  upsertThreadTopicLink(
    link: Records["threadTopicLink"],
  ): Promise<Records["threadTopicLink"]>;

  findThreadTopicLink(params: {
    backend: Records["threadTopicLink"]["backend"];
    channel: Records["channel"]["channel"];
    supergroupId: string;
    threadId: string;
  }): Promise<Records["threadTopicLink"] | undefined>;

  upsertTopicCleanupProposal(
    proposal: Records["topicCleanupProposal"],
  ): Promise<Records["topicCleanupProposal"]>;

  getTopicCleanupProposal(
    id: string,
  ): Promise<Records["topicCleanupProposal"] | undefined>;

  upsertPendingIntent(
    pendingIntent: Records["pendingIntent"],
  ): Promise<Records["pendingIntent"]>;

  getPendingIntent(
    id: string,
    options?: { now?: number },
  ): Promise<Records["pendingIntent"] | undefined>;

  findActivePendingIntentForChannel(params: {
    actorId: string;
    channel: Records["channel"];
    now?: number;
  }): Promise<Records["pendingIntent"] | undefined>;

  findActivePendingIntentsForRequest(params: {
    backend: Records["binding"]["backend"];
    threadId: Records["binding"]["threadId"];
    requestId: string;
    now?: number;
  }): Promise<Records["pendingIntent"][]>;

  findActivePendingAsyncQuestionnaires(params: {
    backend: Records["binding"]["backend"];
    threadId: Records["binding"]["threadId"];
    now?: number;
  }): Promise<Records["pendingIntent"][]>;

  deletePendingIntent(id: string): Promise<void>;

  deletePendingIntentsForChannel(params: {
    channel: Records["channel"];
  }): Promise<string[]>;

  deletePendingIntentsForThread(params: {
    backend: Records["binding"]["backend"];
    threadId: Records["binding"]["threadId"];
  }): Promise<string[]>;

  cleanupExpiredPendingIntents(options?: {
    now?: number;
  }): Promise<string[]>;

  upsertBrowseSession(
    browseSession: Records["browseSession"],
  ): Promise<Records["browseSession"]>;

  getBrowseSession(
    id: string,
    options?: { now?: number },
  ): Promise<Records["browseSession"] | undefined>;

  findActiveBrowseSessionForChannel(params: {
    actorId: string;
    channel: Records["channel"];
    now?: number;
  }): Promise<Records["browseSession"] | undefined>;

  deleteBrowseSession(id: string): Promise<void>;

  cleanupExpiredBrowseSessions(options?: {
    now?: number;
  }): Promise<string[]>;

  upsertCallbackHandle(
    callbackHandle: Records["callbackHandle"],
  ): Promise<Records["callbackHandle"]>;

  getCallbackHandle(
    id: string,
    options?: { now?: number },
  ): Promise<Records["callbackHandle"] | undefined>;

  resolveCallbackHandle(params: {
    actorId: string;
    channel: Records["channel"];
    handle: string;
    now?: number;
  }): Promise<Records["callbackHandle"] | undefined>;

  deleteCallbackHandle(id: string): Promise<void>;

  deleteCallbackHandlesForBinding(params: {
    bindingId: string;
  }): Promise<string[]>;

  cleanupExpiredCallbackHandles(options?: {
    now?: number;
  }): Promise<string[]>;

  recordDelivery(
    delivery: Records["delivery"],
  ): Promise<Records["delivery"]>;

  getDelivery(id: string): Promise<Records["delivery"] | undefined>;

  readSnapshot(): Promise<Records["snapshot"]>;
}

export type MessagingStoreLike<Records extends MessagingStorageRecords> = Pick<
  MessagingStorage<Records>,
  | "upsertBinding"
  | "mergeBindingChannelMetadata"
  | "getBinding"
  | "upsertDefaultAgentAssignment"
  | "getDefaultAgentAssignment"
  | "findActiveDefaultAgentAssignmentForChannel"
  | "findActiveDefaultAgentAssignments"
  | "findActiveDefaultAgentAssignmentsForChannel"
  | "findActiveDefaultAgentAssignmentForScope"
  | "revokeDefaultAgentAssignment"
  | "revokeDefaultAgentAssignmentsForTarget"
  | "findActiveBindingForChannel"
  | "findActiveBindings"
  | "findActiveBindingsForBackend"
  | "findActiveBindingsForThread"
  | "revokeBinding"
  | "upsertMonitorSubscription"
  | "getMonitorSubscription"
  | "findActiveMonitorSubscriptionForChannel"
  | "findActiveMonitorSubscriptionsForChannelKind"
  | "revokeMonitorSubscription"
  | "upsertManagedTopic"
  | "mergeManagedTopicObservation"
  | "getManagedTopic"
  | "findManagedTopicsForSupergroup"
  | "findManagedTopicByConversation"
  | "upsertThreadTopicLink"
  | "findThreadTopicLink"
  | "upsertTopicCleanupProposal"
  | "getTopicCleanupProposal"
  | "upsertPendingIntent"
  | "getPendingIntent"
  | "findActivePendingIntentForChannel"
  | "findActivePendingIntentsForRequest"
  | "findActivePendingAsyncQuestionnaires"
  | "deletePendingIntent"
  | "deletePendingIntentsForChannel"
  | "deletePendingIntentsForThread"
  | "cleanupExpiredPendingIntents"
  | "upsertBrowseSession"
  | "getBrowseSession"
  | "findActiveBrowseSessionForChannel"
  | "deleteBrowseSession"
  | "cleanupExpiredBrowseSessions"
  | "upsertCallbackHandle"
  | "getCallbackHandle"
  | "resolveCallbackHandle"
  | "deleteCallbackHandle"
  | "deleteCallbackHandlesForBinding"
  | "cleanupExpiredCallbackHandles"
  | "recordDelivery"
  | "getDelivery"
  | "readSnapshot"
> & Partial<Pick<
  MessagingStorage<Records>,
  "upsertObservedSurface"
>>;
