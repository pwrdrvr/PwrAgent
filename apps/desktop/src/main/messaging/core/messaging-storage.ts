import type { MessagingStorage, MessagingStoreLike as OwnerMessagingStoreLike } from "@pwragent/owner-core/messaging-storage";
import type { MessagingRequestSource as OwnerMessagingRequestSource, MessagingRequestStorage } from "@pwragent/owner-core/messaging-request-storage";
import type {
  MessagingBindingRecord,
  MessagingChannelRef,
  MessagingObservedSurfaceRecord,
  MessagingDefaultAgentAssignmentRecord,
  MessagingDefaultAgentScope,
  MessagingMonitorSubscriptionRecord,
  MessagingManagedTopicRecord,
  MessagingThreadTopicLinkRecord,
  MessagingTopicCleanupProposalRecord,
  MessagingPendingIntentRecord,
  MessagingBrowseSessionRecord,
  MessagingCallbackHandleRecord,
  MessagingInboundEvent,
} from "@pwragent/messaging-interface";
import type { MessagingDeliveryRecord, MessagingStoreData } from "./messaging-migrations";
import type { MessagingBindingChannelMetadataUpdate, MessagingBindingChannelMetadataMerge, MessagingManagedTopicObservationMerge } from "./messaging-store-merge";

export type DesktopMessagingStorageRecords = {
  binding: MessagingBindingRecord;
  bindingMetadataUpdate: MessagingBindingChannelMetadataUpdate;
  bindingMetadataMerge: MessagingBindingChannelMetadataMerge;
  channel: MessagingChannelRef;
  observedSurface: MessagingObservedSurfaceRecord;
  defaultAgentAssignment: MessagingDefaultAgentAssignmentRecord;
  defaultAgentScope: MessagingDefaultAgentScope;
  monitorSubscription: MessagingMonitorSubscriptionRecord;
  managedTopic: MessagingManagedTopicRecord;
  managedTopicObservationMerge: MessagingManagedTopicObservationMerge;
  threadTopicLink: MessagingThreadTopicLinkRecord;
  topicCleanupProposal: MessagingTopicCleanupProposalRecord;
  pendingIntent: MessagingPendingIntentRecord;
  browseSession: MessagingBrowseSessionRecord;
  callbackHandle: MessagingCallbackHandleRecord;
  delivery: MessagingDeliveryRecord;
  snapshot: MessagingStoreData;
};

export type DesktopMessagingStorage = MessagingStorage<DesktopMessagingStorageRecords>;
export type MessagingStoreLike = OwnerMessagingStoreLike<DesktopMessagingStorageRecords>;
export type MessagingRequestSource = OwnerMessagingRequestSource<MessagingInboundEvent>;
export type MessagingRequestStore = MessagingRequestStorage<MessagingInboundEvent>;
