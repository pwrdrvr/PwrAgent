import type { MessagingDeliveryResult } from "@pwragent/messaging-interface";
import type {
  MessagingDeliveryRecord,
  MessagingReplyReceipt,
  MessagingReplyReceiptReason,
} from "./messaging-migrations";

/**
 * Delivery receipts for final assistant replies and approval cards.
 *
 * Messaging providers give no idempotency key, so the promise is "delivered
 * once, or flagged", not exactly-once. A receipt is written as `pending`
 * before the send and settled after it, in a second commit that replaces the
 * delivery row every send already wrote. Only a send that provably never
 * reached the provider is left open as `owed` and sent again; every
 * ambiguous outcome settles as `unknown` and is flagged for the operator.
 * This follows the receipt rule of `research_deliveries` and of automation
 * output actions: a marker left by a crash is never re-posted.
 *
 * Receipts live in the existing `deliveries` table, keyed by an id prefix,
 * so older releases read them as ordinary delivery rows.
 */
export const OPEN_REPLY_RECEIPT_PREFIX = "reply-receipt:open:";

/** An owed reply older than this is flagged instead of sent. */
export const REPLY_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/** Outcomes that mean the provider accepted the send. */
const ACCEPTED_OUTCOMES = new Set<MessagingDeliveryResult["outcome"]>([
  "presented",
  "updated",
  "presented_new",
  "signaled",
  "pinned",
  "unpinned",
  "dismissed",
]);

/**
 * Receipts with a send in progress in this process. A controller restarted
 * while an older one is still sending must not read that receipt as
 * interrupted, and two recovery passes must not both resend one reply.
 */
const inFlightReceiptIds = new Set<string>();

export function claimReplyReceipt(openId: string): boolean {
  if (inFlightReceiptIds.has(openId)) return false;
  inFlightReceiptIds.add(openId);
  return true;
}

export function releaseReplyReceipt(openId: string): void {
  inFlightReceiptIds.delete(openId);
}

export function isReplyReceiptInFlight(openId: string): boolean {
  return inFlightReceiptIds.has(openId);
}

export type ReplyReceiptIdentity = Omit<
  MessagingReplyReceipt,
  "state" | "markedAt" | "attempts" | "reason"
> & { bindingId: string };

export function openReplyReceiptId(identity: ReplyReceiptIdentity): string {
  const parts = identity.kind === "approval"
    ? [identity.bindingId, identity.kind, identity.pendingIntentId ?? ""]
    : [identity.bindingId, identity.kind, identity.turnId ?? "", identity.itemId ?? ""];
  return OPEN_REPLY_RECEIPT_PREFIX + parts.map(encodeURIComponent).join(":");
}

export function isAcceptedDeliveryOutcome(
  outcome: MessagingDeliveryResult["outcome"],
): boolean {
  return ACCEPTED_OUTCOMES.has(outcome);
}

export type OpenReplyReceiptDecision =
  | { action: "skip" }
  | { action: "resend" }
  | { action: "flag"; reason: MessagingReplyReceiptReason };

/**
 * What a recovery pass does with one open receipt. A `pending` receipt with
 * no send in progress was left by a crash or a failed settle: the request may
 * have been written, so it is flagged, never sent.
 */
export function decideOpenReplyReceipt(params: {
  openId: string;
  receipt: MessagingReplyReceipt;
  now: number;
}): OpenReplyReceiptDecision {
  const { openId, receipt, now } = params;
  if (isReplyReceiptInFlight(openId)) return { action: "skip" };
  if (receipt.state === "pending") return { action: "flag", reason: "interrupted" };
  if (receipt.state !== "owed") return { action: "skip" };
  if (now - receipt.markedAt > REPLY_RECEIPT_TTL_MS) {
    return { action: "flag", reason: "expired" };
  }
  return { action: "resend" };
}

export function openReplyReceiptRecord(params: {
  openId: string;
  bindingId: string;
  channel: MessagingDeliveryRecord["channel"];
  intentId: string;
  receipt: MessagingReplyReceipt;
  at: number;
}): MessagingDeliveryRecord {
  return {
    id: params.openId,
    bindingId: params.bindingId,
    channel: params.channel,
    // Open rows are not deliveries; an older release reads them as discarded.
    outcome: "discarded",
    deliveredAt: params.at,
    intentId: params.intentId,
    receipt: params.receipt,
  };
}

/** A simulated process exit forgets sends in flight, as a real one does. */
export function forgetInFlightReplyReceiptsForTests(): void {
  inFlightReceiptIds.clear();
}
