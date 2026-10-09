import type {
  AppServerBackendKind,
  AppServerThreadStatus,
  ThreadIdentifier,
} from "./contracts/normalized-app-server";
import type { ThreadPricingSummary } from "./token-usage-pricing";

export type ReadThreadFamilyPricingRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
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
};

export type ReadThreadFamilyPricingResponse = {
  /** The requested thread first, then its sub-threads by spend, largest first. */
  members: ThreadFamilyPricingMember[];
  readAt: number;
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
  root: ReadThreadFamilyPricingRequest;
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
  const rootKey = key(params.root.backend, params.root.threadId);
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
  members.sort((left, right) =>
    Number(right.self) - Number(left.self)
    || right.totalCostMicros - left.totalCostMicros
    || left.title.localeCompare(right.title));
  return { members, readAt: params.readAt };
}
