import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { getMainLogger } from "../log";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

export function logUnpricedThreadUsageLine(line: ThreadUsageLineRecord): void {
  if (line.priceStatus !== "unpriced") {
    return;
  }
  backendRegistryLog.warn("thread usage line persisted without list price", {
    backend: line.backend,
    cachedInputTokens: line.cachedInputTokens,
    fastMode: line.fastMode,
    model: line.model,
    outputTokens: line.outputTokens,
    parentThreadId: line.parentThreadId,
    priceUnavailableReason: line.priceUnavailableReason,
    reasoningEffort: line.reasoningEffort,
    reasoningOutputTokens: line.reasoningOutputTokens,
    scope: line.scope,
    serviceTier: line.serviceTier,
    settingsConfidence: line.settingsConfidence,
    settingsSource: line.settingsSource,
    source: line.source,
    threadId: line.threadId,
    turnId: line.turnId,
    uncachedInputTokens: line.uncachedInputTokens,
    usageLineId: line.usageLineId,
  });
}
