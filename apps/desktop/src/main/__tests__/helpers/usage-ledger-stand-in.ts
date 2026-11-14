import type { ThreadSubAgentSummary, ThreadUsageLineRecord } from "@pwragent/shared";
import type { RegistryContext } from "../../app-server/registry-context";
import { ThreadUsageLedger } from "../../app-server/thread-usage-ledger";

/**
 * A real usage ledger for a registry stand-in built from the registry's
 * prototype. The registry reads live gates and pricing through its ledger,
 * so a stand-in without one reaches no live state. The ledger reads the
 * stand-in's own store and the stand-in as its host, as the composition
 * root's ports are the registry, and holds the given live gate cards and
 * usage lines.
 */
export function usageLedgerStandIn(params: {
  registry?: () => object;
  overlayStore?: object;
  subAgentMonitorService: object;
  usageLines?: Map<string, Map<string, ThreadUsageLineRecord>>;
  subAgents?: Map<string, Map<string, ThreadSubAgentSummary>>;
}): ThreadUsageLedger {
  const store = params.overlayStore ?? {};
  const context = { stores: { threads: store, usage: store, subAgents: store, toolAccounting: store } };
  const ledger = new ThreadUsageLedger(context as unknown as RegistryContext, {
    managedReviewService: {} as never,
    subAgentMonitorService: params.subAgentMonitorService as never,
  }, () => (params.registry?.() ?? {}) as never);
  const live = ledger as unknown as {
    liveTokenMiserUsageLines: Map<string, Map<string, ThreadUsageLineRecord>>;
    liveTokenMiserSubAgents: Map<string, Map<string, ThreadSubAgentSummary>>;
  };
  for (const [threadId, lines] of params.usageLines ?? []) live.liveTokenMiserUsageLines.set(threadId, lines);
  for (const [threadId, cards] of params.subAgents ?? []) live.liveTokenMiserSubAgents.set(threadId, cards);
  return ledger;
}
