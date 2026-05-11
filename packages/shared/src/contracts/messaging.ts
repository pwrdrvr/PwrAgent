// Messaging primitives that live in @pwragent/shared because shared internals
// (e.g. settings) need them. Everything else messaging-related — intents,
// surfaces, capability profile, attachments, callbacks — lives in
// @pwragent/messaging-interface, which re-exports these primitives so
// consumers see a single canonical type set.

import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "./normalized-app-server";

export const MESSAGING_TOOL_UPDATE_MODES = [
  "show_none",
  "show_less",
  "show_some",
  "show_more",
  "show_all",
] as const;

export type MessagingToolUpdateMode = (typeof MESSAGING_TOOL_UPDATE_MODES)[number];

// String-literal primitives duplicated locally so shared/contracts/navigation.ts
// can describe MessagingThreadBindingSummary without importing
// @pwragent/messaging-interface (that would create a dependency
// cycle since messaging-interface depends on @pwragent/shared).
// Keeping these in lockstep with messaging-interface's copy is
// trivial — both are string-literal unions with no behavior.

export type MessagingChannelKind =
  | "telegram"
  | "discord"
  | "slack"
  | "mattermost"
  | "feishu"
  | "googlechat"
  | "msteams"
  | "matrix"
  | "irc"
  | "imessage"
  | "signal"
  | "whatsapp"
  | "line"
  | "zalo"
  | "nextcloud-talk"
  | "synology-chat"
  | "twitch"
  | "nostr"
  | "qqbot"
  | "bluebubbles"
  | "tlon"
  | "voice-call"
  | "custom";

export type MessagingConversationKind = "dm" | "channel" | "thread" | "topic";

export type MessagingDeliveryScopeKind =
  | "global"
  | "dm"
  | "group"
  | "channel"
  | "thread"
  | "topic"
  | "route"
  | "workspace"
  | "server"
  | "custom";

export type MessagingDeliveryScopeBudget = {
  limit: number;
  intervalMs: number;
  reserved?: number;
};

export type MessagingDeliveryScope = {
  platform: MessagingChannelKind;
  id: string;
  kind: MessagingDeliveryScopeKind;
  label?: string;
  parentId?: string;
  bucketId?: string;
  budget?: MessagingDeliveryScopeBudget;
};

type MessagingDegradationBase = {
  key: string;
  message?: string;
  scope?: MessagingDeliveryScope;
  startedAt: number;
};

export type MessagingRateLimitedDegradationReason = MessagingDegradationBase & {
  kind: "rate-limited";
  retryAfterMs?: number;
  expiresAt: number;
};

export type MessagingReconnectingDegradationReason = MessagingDegradationBase & {
  kind: "reconnecting";
  attemptCount?: number;
  lastFailureReason?: string;
};

export type MessagingMissingPermissionDegradationReason = MessagingDegradationBase & {
  kind: "missing-permission";
  bindingId?: string;
  permission?: string;
};

export type MessagingWarningDegradationReason = MessagingDegradationBase & {
  kind: "warning";
  expiresAt?: number;
};

export type MessagingDegradationReason =
  | MessagingRateLimitedDegradationReason
  | MessagingReconnectingDegradationReason
  | MessagingMissingPermissionDegradationReason
  | MessagingWarningDegradationReason;

/**
 * Health/lifecycle state for a single configured messaging platform.
 *   - `enabled`   adapter started successfully and is currently listening
 *   - `degraded` adapter is connected but temporarily constrained
 *   - `suspended` configured but stopped (user toggled messaging off)
 *   - `errored`   the adapter failed to start, or hit a fatal runtime error
 *   - `unknown`   we know the platform is configured but haven't observed
 *                 a transition yet (initial-load / pre-start state)
 */
export type MessagingPlatformHealth =
  | "enabled"
  | "degraded"
  | "suspended"
  | "errored"
  | "unknown";

/**
 * Snapshot of one platform's current state. Renderer holds an array
 * (one per configured platform) and updates it from
 * `MessagingPlatformStatusEvent`s.
 */
export type MessagingPlatformStatus = {
  platform: MessagingChannelKind;
  health: MessagingPlatformHealth;
  /** Wall-clock ms when the health last changed. */
  changedAt: number;
  /** Public identity observed at adapter startup, e.g. bot username. */
  account?: string;
  /** Short public detail for the identity, e.g. API host or workspace. */
  detail?: string;
  /** When errored, a human-readable reason for the UI tooltip. */
  reason?: string;
  /** Transient provider/runtime reasons that make an enabled platform degraded. */
  degradationReasons?: MessagingDegradationReason[];
  /**
   * Wall-clock ms of the last sent or received message that the
   * runtime told us about. Used to keep the activity dot blinking for
   * a short tail (~2s) after the last event.
   */
  lastActivityAt?: number;
};

export type MessagingPlatformStatusEvent =
  | {
      kind: "health-changed";
      platform: MessagingChannelKind;
      health: MessagingPlatformHealth;
      account?: string;
      detail?: string;
      reason?: string;
      degradationReasons?: MessagingDegradationReason[];
      at: number;
    }
  | {
      kind: "activity";
      platform: MessagingChannelKind;
      at: number;
    };

/** Persisted messaging activity log row. Capped per-platform with FIFO eviction. */
export type MessagingActivityKind =
  | "inbound-routed"
  | "inbound-rejected"
  | "inbound-ignored"
  | "pairing"
  | "outbound"
  | "binding"
  | "diagnostic";

export type MessagingActivityEntry = {
  id: number;
  platform: MessagingChannelKind;
  kind: MessagingActivityKind;
  /** Backend the entry routed to / from, if known. */
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  bindingId?: string;
  conversationId?: string;
  conversationTitle?: string;
  actorId?: string;
  actorDisplayName?: string;
  summary: string;
  createdAt: number;
  /**
   * Free-form bag of fields the row remembers without growing dedicated
   * columns. Renderer may show these in the activity detail panel;
   * consumers must treat the shape as opaque (current keys include
   * `eventId`, `eventKind`, `conversationKind`, `actorUsername`,
   * `actorIsBot`, plus any caller-provided extras).
   */
  payload?: Record<string, unknown>;
};

export type ListMessagingActivityRequest = {
  /** Most recent first. Default 100, capped at 500. */
  limit?: number;
  /** When set, only entries strictly newer than `sinceId` are returned. */
  sinceId?: number;
};

export type ListMessagingActivityResponse = {
  entries: MessagingActivityEntry[];
};

export type UnbindMessagingThreadRequest = {
  bindingId: string;
};

export type UnbindMessagingThreadResponse = {
  /** True when the binding existed and was revoked. */
  revoked: boolean;
  /** Echoed for client-side cache eviction. */
  bindingId: string;
};

export type SetMessagingEnabledRequest = {
  enabled: boolean;
};

export type SetMessagingEnabledResponse = {
  /** Effective runtime state after the toggle. */
  enabled: boolean;
  /** True when the process was launched with a no-messaging override. */
  overridden: boolean;
  /** Human-readable explanation of the launch override, when applicable. */
  overrideReason?: string;
};

export type MessagingPairingScope = "user_dm" | "bucket" | "user_in_group";

export type MessagingPairingStatus =
  | "pending"
  | "observed"
  | "approved"
  | "rejected"
  | "expired"
  | "consumed";

export type MessagingPairingObservedActor = {
  id: string;
  displayName?: string;
  phoneNumber?: string;
  username?: string;
};

export type MessagingPairingObservedChat = {
  id: string;
  kind: MessagingConversationKind;
  title?: string;
  parentId?: string;
  parentTitle?: string;
  bucketId?: string;
};

export type MessagingPairingEntry = {
  id: string;
  platform: MessagingChannelKind;
  instanceId: string;
  scope: MessagingPairingScope;
  status: MessagingPairingStatus;
  generatedAt: number;
  expiresAt: number;
  observedAt?: number;
  observedActor?: MessagingPairingObservedActor;
  observedChat?: MessagingPairingObservedChat;
  failureReason?: string;
};

export type GenerateMessagingPairingTokenRequest = {
  platform: MessagingChannelKind;
  instanceId?: string;
  scope: MessagingPairingScope;
  ttlMs?: number;
};

export type GenerateMessagingPairingTokenResponse = {
  entry: MessagingPairingEntry;
  message: string;
  token: string;
  expiresAt: number;
};

export type ListMessagingPairingRequestsRequest = {
  platform?: MessagingChannelKind;
  includeResolved?: boolean;
};

export type ListMessagingPairingRequestsResponse = {
  entries: MessagingPairingEntry[];
};

export type ApproveMessagingPairingRequest = {
  entryId: string;
};

export type ApproveMessagingPairingResponse = {
  entry: MessagingPairingEntry;
  added: boolean;
};

export type RejectMessagingPairingRequest = {
  entryId: string;
};

export type RejectMessagingPairingResponse = {
  entry: MessagingPairingEntry;
};
