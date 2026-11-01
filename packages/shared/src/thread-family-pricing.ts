import type {
  AppServerBackendKind,
  AppServerThreadStatus,
  ThreadIdentifier,
} from "./contracts/normalized-app-server";
import type { ThreadPricingSummary } from "./token-usage-pricing";
import type { FederationTarget } from "./contracts/federation";

export type ReadThreadFamilyPricingRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** The owner collates membership and stored totals for the whole family. */
  federationTarget?: FederationTarget;
};

/**
 * One thread's stored running total. Codex sub-agent spend is already inside
 * it: native sub-agent usage rows roll up to the thread that started them.
 */
export type ThreadFamilyPricingMember = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  title: string;
  /** The thread the family was read for. */
  self: boolean;
  /** A turn is running, so the stored total is still moving. */
  active: boolean;
  totalCostMicros: number;
  usageLineCount: number;
  unpricedUsageLineCount: number;
  /**
   * The instance that owns the thread and keeps its total, when that is not
   * the machine that answered the read. Absent: the answering machine.
   */
  ownerInstanceId?: string;
  /** The owner's name as the answering machine knows it. */
  instanceLabel?: string;
  /** The owner could not be reached, so this thread is not in the total. */
  unavailable?: true;
};

/**
 * A sub-thread the owner knows of that another instance keeps. Only that
 * instance holds its total, so the reader asks it directly.
 */
export type ThreadFamilyPricingReferral = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  ownerInstanceId: string;
  /** Sent only to the local reader; an owner never forwards another instance's titles. */
  title?: string;
  instanceLabel?: string;
};

export type ReadThreadFamilyPricingResponse = {
  /** The requested thread first, then its sub-threads by spend, largest first. */
  members: ThreadFamilyPricingMember[];
  readAt: number;
  /** Sub-threads on other instances. Owners that predate them omit this. */
  referrals?: ThreadFamilyPricingReferral[];
};

export type ThreadFamilyPricingInputMember = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  title: string;
  threadStatus?: AppServerThreadStatus;
};

/**
 * Sum each member's stored USD summaries. A thread can hold one summary per
 * provider; other currencies are left out rather than added to dollars.
 */
export function summarizeThreadFamilyPricing(params: {
  /** Absent when the family root lives on another instance. */
  root?: Pick<ReadThreadFamilyPricingRequest, "backend" | "threadId">;
  members: readonly ThreadFamilyPricingInputMember[];
  summaries: readonly ThreadPricingSummary[];
  readAt: number;
}): ReadThreadFamilyPricingResponse {
  const key = (backend: string, threadId: string) => JSON.stringify([backend, threadId]);
  const totals = new Map<string, Pick<ThreadFamilyPricingMember, "totalCostMicros" | "usageLineCount" | "unpricedUsageLineCount">>();
  for (const summary of params.summaries) {
    if (summary.currency !== "USD") continue;
    const memberKey = key(summary.backend, summary.threadId);
    const total = totals.get(memberKey) ?? { totalCostMicros: 0, usageLineCount: 0, unpricedUsageLineCount: 0 };
    total.totalCostMicros += summary.totalCostMicros;
    total.usageLineCount += summary.usageLineCount;
    total.unpricedUsageLineCount += summary.unpricedUsageLineCount;
    totals.set(memberKey, total);
  }
  const rootKey = params.root ? key(params.root.backend, params.root.threadId) : undefined;
  const seen = new Set<string>();
  const members: ThreadFamilyPricingMember[] = [];
  for (const member of params.members) {
    const memberKey = key(member.backend, member.threadId);
    if (seen.has(memberKey)) continue;
    seen.add(memberKey);
    members.push({
      backend: member.backend,
      threadId: member.threadId,
      title: member.title,
      self: memberKey === rootKey,
      active: member.threadStatus === "active",
      ...(totals.get(memberKey) ?? { totalCostMicros: 0, usageLineCount: 0, unpricedUsageLineCount: 0 }),
    });
  }
  members.sort(compareThreadFamilyPricingMembers);
  return { members, readAt: params.readAt };
}

/** The thread itself, then spend, largest first; unreachable threads last. */
export function compareThreadFamilyPricingMembers(
  left: ThreadFamilyPricingMember,
  right: ThreadFamilyPricingMember,
): number {
  return Number(right.self) - Number(left.self)
    || Number(Boolean(left.unavailable)) - Number(Boolean(right.unavailable))
    || right.totalCostMicros - left.totalCostMicros
    || left.title.localeCompare(right.title);
}
