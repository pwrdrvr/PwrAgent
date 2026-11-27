import { LivePricingLines } from "../../app-server/live-pricing-lines";
import type { ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { ThreadUsageLedger } from "../../app-server/thread-usage-ledger";
import { registryContextStandIn } from "./registry-context-stand-in";

/** A real ledger seeded with live usage for consumers of the registry's read ports. */
export function usageLedgerStandIn(params: {
  registry?: () => object;
  overlayStore?: object;
  subAgentMonitorService: object;
  usageLines?: Map<string, Map<string, ThreadUsageLineRecord>>;
  subAgents?: Map<string, Map<string, ThreadSubAgentSummary>>;
}): ThreadUsageLedger {
  const context = registryContextStandIn({ overlayStore: params.overlayStore });
  const ledger = new ThreadUsageLedger(context, {
    managedReviewService: {} as never,
    subAgentMonitorService: params.subAgentMonitorService as never,
  }, () => (params.registry?.() ?? {}) as never);
  const live = ledger as unknown as {
    liveTokenMiserUsageLines: Map<string, Map<string, ThreadUsageLineRecord>>;
    liveTokenMiserSubAgents: Map<string, Map<string, ThreadSubAgentSummary>>;
  };
  for (const [threadId, lines] of params.usageLines ?? []) live.liveTokenMiserUsageLines.set(threadId, new LivePricingLines(lines));
  for (const [threadId, cards] of params.subAgents ?? []) live.liveTokenMiserSubAgents.set(threadId, cards);
  return ledger;
}
