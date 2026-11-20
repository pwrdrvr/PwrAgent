import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  GetMessagingActivitySummaryResponse,
  MessagingActivityEntry,
  MessagingActivityKind,
  MessagingActivityOrigin,
  MessagingChannelKind,
} from "@pwragent/shared/contracts/messaging";

export type RecordMessagingActivityInput = {
  platform: MessagingActivityOrigin;
  kind: MessagingActivityKind;
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  bindingId?: string;
  conversationId?: string;
  conversationTitle?: string;
  actorId?: string;
  actorDisplayName?: string;
  summary: string;
  createdAt?: number;
  /**
   * Free-form bag of fields the row should remember without growing
   * dedicated columns. Renderer may show these in the activity detail
   * panel; consumers must treat the shape as opaque.
   */
  payload?: Record<string, unknown>;
};

export type RecordMessagingPlatformResponseActivityInput = {
  platform: MessagingChannelKind;
  createdAt?: number;
};

export interface MessagingActivityStorage {
  record(entry: RecordMessagingActivityInput): MessagingActivityEntry;

  recordPlatformResponseActivity(
    entry: RecordMessagingPlatformResponseActivityInput,
  ): void;

  list(params?: {
    limit?: number;
    sinceId?: number;
  }): MessagingActivityEntry[];

  getPlatformActivitySummary(): GetMessagingActivitySummaryResponse;
}
