import type {
  MessagingChannelKind,
  MessagingPairingApprovalTarget,
  MessagingPairingEntry,
  MessagingPairingObservedActor,
  MessagingPairingObservedChat,
  MessagingPairingScope,
  MessagingPairingStatus,
  RevokeTelegramPairingGrantRequest,
} from "@pwragent/shared/contracts/messaging";
import type { DesktopAuthorizedContact, DesktopTelegramPairingGrants } from "@pwragent/shared/contracts/settings";

export interface MessagingPairingStorage {
  readTelegramGrants(accountId: string): DesktopTelegramPairingGrants;

  approveTelegramPairing(params: {
    entryId: string;
    contact: DesktopAuthorizedContact;
    now: number;
    resolveCurrentAccountId: () => string | undefined;
  }): { entry: MessagingPairingEntry; added: boolean } | "different-bot" | "unavailable";

  revokeTelegramGrant(request: RevokeTelegramPairingGrantRequest): void;

  dismissTelegramGrantWarning(accountId: string, contactId: string): void;

  create(params: {
    token: string;
    platform: MessagingChannelKind;
    instanceId: string;
    scope: MessagingPairingScope;
    generatedAt: number;
    expiresAt: number;
  }): MessagingPairingEntry;

  findMatchingPending(params: {
    token: string;
    platform: MessagingChannelKind;
    instanceId: string;
    now: number;
  }): MessagingPairingEntry | undefined;

  get(entryId: string, options?: { now?: number }): MessagingPairingEntry | undefined;

  list(params: {
    includeResolved?: boolean;
    platform?: MessagingChannelKind;
    now: number;
  }): MessagingPairingEntry[];

  countOutstanding(params: {
    platform: MessagingChannelKind;
    instanceId: string;
    now: number;
  }): number;

  markObserved(params: {
    entryId: string;
    observedAt: number;
    actor: MessagingPairingObservedActor;
    chat: MessagingPairingObservedChat;
  }): MessagingPairingEntry | undefined;

  markStatus(params: {
    entryId: string;
    status: Extract<MessagingPairingStatus, "approved" | "rejected" | "consumed">;
    failureReason?: string;
  }): MessagingPairingEntry | undefined;

  recordApproval(params: {
    entryId: string;
    target: MessagingPairingApprovalTarget;
  }): MessagingPairingEntry | undefined;

  expireBefore(now: number): void;
}
