import type { FederationProtocolEnvelope } from "@pwragent/shared";
import { createHash } from "node:crypto";

export type FederationEnvelopeLogFields = Record<string, string | undefined>;

/** Account for large live notifications without recording any payload text. */
export function describeLargeBackendEvent(envelope: FederationProtocolEnvelope): Record<string, number> {
  if (envelope.kind !== "notification" || envelope.method !== "backend.event"
    || !envelope.params || typeof envelope.params !== "object") return {};
  const event = envelope.params as Record<string, unknown>;
  const notification = event.notification as { params?: Record<string, unknown> } | undefined;
  if (!notification?.params || typeof notification.params !== "object") return {};
  const { pricing, toolAccounting, ...other } = notification.params;
  const measure = (value: unknown): number => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");
  const stream = event.stream as { sequence?: unknown } | undefined;
  return {
    notificationParamsBytes: measure(notification.params),
    pricingBytes: measure(pricing),
    toolAccountingBytes: measure(toolAccounting),
    otherNotificationParamsBytes: measure(other),
    accountingPatchBytes: measure(event.accountingPatch),
    ...(typeof stream?.sequence === "number" ? { streamSequence: stream.sequence } : {}),
  };
}

/** Size-only diagnostics for the existing large-frame log, never payload text.
 * Parts are measured one at a time; no serialized replay is retained.
 * Inline image counters are a subset of the part bytes and count wire copies.
 */
export function describeLargeThreadReadResult(envelope: FederationProtocolEnvelope): Record<string, number> {
  if (envelope.kind !== "response" || !envelope.result || typeof envelope.result !== "object") return {};
  const result = envelope.result as Record<string, unknown>;
  if (!result.replay || typeof result.replay !== "object") return {};
  const { replay, pricing, toolAccounting, ...other } = result;
  const { entries, messages, ...metadata } = replay as Record<string, unknown>;
  let inlineImageUrlCount = 0;
  let inlineImageUrlBytes = 0;
  const measure = (value: unknown): number => {
    if (value === undefined) return 0;
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "string" && item.startsWith("data:image/")) {
        inlineImageUrlCount += 1;
        inlineImageUrlBytes += Buffer.byteLength(item, "utf8");
      }
      return item;
    });
    return Buffer.byteLength(serialized, "utf8");
  };
  const size = (value: unknown): number => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");
  const rows = Array.isArray(entries) ? entries as Record<string, unknown>[] : [];
  const display = result.display as { pricingPage?: { rows?: Array<{ gates?: unknown[]; gatesDeferred?: boolean }> } } | undefined;
  const pricingRows = display?.pricingPage?.rows;
  return {
    replayEntryCount: Array.isArray(entries) ? entries.length : 0,
    replayMessageCount: Array.isArray(messages) ? messages.length : 0,
    ...(display ? { displayBytes: size(display) } : {}),
    ...(Array.isArray(pricingRows) ? {
      pricingDisplayBytes: size(display?.pricingPage),
      pricingRowCount: pricingRows.length,
      pricingNestedRowCount: pricingRows.reduce((sum, row) => sum + (row.gates?.length ?? 0), 0),
      deferredPricingGroupCount: pricingRows.filter((row) => row.gatesDeferred).length,
    } : {}),
    replayEntriesBytes: measure(entries),
    replayMessagesBytes: measure(messages),
    replayMetadataBytes: measure(metadata),
    pricingBytes: measure(pricing),
    toolAccountingBytes: measure(toolAccounting),
    otherResultBytes: measure(other),
    inlineImageUrlCount,
    inlineImageUrlBytes,
    messageTextBytes: rows.reduce((sum, row) => sum + (row.type === "message" ? size(row.text) : 0), 0),
    activityDetailsBytes: rows.reduce((sum, row) => sum + (row.type === "activity" ? size(row.details) : 0), 0),
    deferredActivityCount: rows.filter((row) => row.type === "activity" && row.detailsRef).length,
  };
}

/** Volatile metadata only. Shared across gateway sockets to correlate relay hops.
 * Keep completed entries briefly: receiving a response precedes forwarding it.
 */
export class FederationEnvelopeDiagnostics {
  private readonly requests = new Map<string, {
    method: string;
    navigation?: FederationEnvelopeLogFields;
    queryFingerprint?: string;
    threadId?: string;
    readReason?: string;
    displayResource?: string;
    deferredActivityDetails?: string;
    deferredPricingGates?: string;
    pricingGateFilter?: string;
    conditionalRead?: string;
    expiresAt: number;
  }>();

  constructor(
    private readonly now = Date.now,
    private readonly capacity = 4096,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  observe(envelope: FederationProtocolEnvelope): void {
    if (envelope.kind !== "request") return;
    const key = JSON.stringify([envelope.id, envelope.sourceInstanceId, envelope.targetInstanceId]);
    const existing = this.requests.get(key);
    if (existing && existing.expiresAt > this.now()) return;
    this.requests.delete(key);
    while (this.requests.size >= Math.max(1, this.capacity)) {
      this.requests.delete(this.requests.keys().next().value!);
    }
    this.requests.set(key, {
      method: envelope.method,
      navigation: navigationRequestLogFields(envelope),
      queryFingerprint: searchQueryFingerprint(envelope),
      ...threadReadLogFields(envelope),
      expiresAt: this.now() + this.ttlMs,
    });
  }

  describe(
    envelope: FederationProtocolEnvelope,
    label: (id: string) => string | undefined = () => undefined,
  ): FederationEnvelopeLogFields {
    const requestId = envelope.kind === "request" ? envelope.id
      : envelope.kind === "response" || envelope.kind === "error" ? envelope.requestId : undefined;
    const key = JSON.stringify([requestId, envelope.targetInstanceId, envelope.sourceInstanceId]);
    const request = this.requests.get(key);
    if (request && request.expiresAt <= this.now()) this.requests.delete(key);
    const method = envelope.kind === "request" || envelope.kind === "notification"
      ? envelope.method
      : request && request.expiresAt > this.now() ? request.method : "unknown";
    const params = envelope.kind === "notification" ? envelope.params : undefined;
    const notification = params && typeof params === "object" && "notification" in params
      ? params.notification : undefined;
    const notificationParams = notification && typeof notification === "object" && "params" in notification
      && notification.params && typeof notification.params === "object" ? notification.params : undefined;
    return {
      envelopeKind: envelope.kind,
      envelopeId: envelope.id,
      requestId,
      method,
      queryFingerprint: envelope.kind === "request" ? searchQueryFingerprint(envelope)
        : request && request.expiresAt > this.now() ? request.queryFingerprint : undefined,
      ...(envelope.kind === "request" ? threadReadLogFields(envelope)
        : request && request.expiresAt > this.now()
          ? { threadId: request.threadId, readReason: request.readReason,
            displayResource: request.displayResource, deferredActivityDetails: request.deferredActivityDetails,
            deferredPricingGates: request.deferredPricingGates, pricingGateFilter: request.pricingGateFilter,
            conditionalRead: request.conditionalRead }
          : {}),
      ...(notificationParams && "threadId" in notificationParams
        && typeof notificationParams.threadId === "string" && notificationParams.threadId.length <= 256
        ? { threadId: notificationParams.threadId } : {}),
      ...(notification && typeof notification === "object" && "method" in notification
        && notification.method === "navigation/invalidated" && notificationParams
        && "sourceMethod" in notificationParams && typeof notificationParams.sourceMethod === "string"
        && /^[A-Za-z][A-Za-z0-9/_.-]{0,199}$/.test(notificationParams.sourceMethod)
        ? { sourceMethod: notificationParams.sourceMethod } : {}),
      ...(envelope.kind === "request" ? navigationRequestLogFields(envelope)
        : request && request.expiresAt > this.now() ? request.navigation : {}),
      ...(method === "backend.getNavigationQueryPage" ? navigationResponseLogFields(envelope) : {}),
      errorCode: envelope.kind === "error" ? envelope.error.code : undefined,
      notificationMethod: notification && typeof notification === "object"
        && "method" in notification && typeof notification.method === "string"
        ? notification.method : undefined,
      sourceInstanceId: envelope.sourceInstanceId,
      sourceInstanceLabel: label(envelope.sourceInstanceId),
      targetInstanceId: envelope.targetInstanceId,
      targetInstanceLabel: envelope.targetInstanceId ? label(envelope.targetInstanceId) : undefined,
    };
  }
}

function threadReadLogFields(envelope: FederationProtocolEnvelope): {
  threadId?: string;
  readReason?: string;
  displayResource?: string;
  deferredActivityDetails?: string;
  deferredPricingGates?: string;
  pricingGateFilter?: string;
  conditionalRead?: string;
} {
  if (envelope.kind !== "request" || envelope.method !== "backend.readThread") return {};
  const params = envelope.params;
  if (!params || typeof params !== "object") return {};
  const display = "display" in params && params.display && typeof params.display === "object" ? params.display : undefined;
  const group = display && "pricingGateGroup" in display && display.pricingGateGroup && typeof display.pricingGateGroup === "object" ? display.pricingGateGroup : undefined;
  return {
    threadId: "threadId" in params && typeof params.threadId === "string" && params.threadId.length <= 256
      ? params.threadId : undefined,
    readReason: "readReason" in params && (params.readReason === "star-map-card" || params.readReason === "thread-view")
      ? params.readReason : undefined,
    displayResource: display && "resource" in display && typeof display.resource === "string"
      && ["transcript", "activity", "accounting", "pricing", "tools", "incident", "subagents", "subagent"].includes(display.resource)
      ? display.resource : undefined,
    deferredActivityDetails: display && "deferActivityDetails" in display && display.deferActivityDetails === true ? "true" : undefined,
    deferredPricingGates: display && "deferPricingGates" in display && display.deferPricingGates === true ? "true" : undefined,
    pricingGateFilter: group && "filter" in group && (group.filter === "primary" || group.filter === "small") ? group.filter : undefined,
    conditionalRead: "knownRevision" in params && typeof params.knownRevision === "string"
      ? params.knownRevision.length > 0 ? "revalidate" : "initial" : undefined,
  };
}

function searchQueryFingerprint(envelope: FederationProtocolEnvelope): string | undefined {
  if (envelope.kind !== "request"
    || (envelope.method !== "backend.searchNavigationThreads" && envelope.method !== "backend.searchFederatedThreads")) return undefined;
  const params = envelope.params;
  if (!params || typeof params !== "object" || !("query" in params) || typeof params.query !== "string") return undefined;
  return createHash("sha256").update(params.query.trim()).digest("hex").slice(0, 12);
}

// Fingerprints identify semantic requests and owner revisions without retaining
// identities, directory paths, search text, cursors, or row payloads.
function fingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return createHash("sha256").update(canonical ?? "null").digest("hex").slice(0, 16);
}
function navigationRequestLogFields(envelope: FederationProtocolEnvelope): FederationEnvelopeLogFields {
  if (envelope.kind !== "request" || envelope.method !== "backend.getNavigationQueryPage") return {};
  const params = envelope.params as Record<string, unknown> | undefined;
  if (!params || typeof params !== "object") return {};
  const query = params.query as Record<string, unknown> | undefined;
  const token = (value: unknown) => typeof value === "string" && /^[a-z][a-z-]{0,39}$/.test(value) ? value : undefined;
  return {
    navigationQuery: token(query?.kind), navigationConsumer: token(params.consumer),
    navigationReadReason: ["demand", "refresh", "continuation", "rebaseline", "pins"].includes(String(params.readReason))
      ? String(params.readReason) : undefined,
    navigationQueryFingerprint: fingerprint({ query, backend: params.backend ?? "all", inventory: params.inventory ?? "owner", attentionView: params.attentionView }),
    navigationBaseline: typeof params.completeBaselineRevision === "string" ? fingerprint(params.completeBaselineRevision) : undefined,
    navigationConditional: String(Boolean(params.completeBaselineRevision)),
    navigationCursorFingerprint: typeof params.cursor === "string" ? fingerprint(params.cursor) : undefined,
    navigationCursor: String(Boolean(params.cursor)), navigationRetainedRange: String(Boolean(params.retainedRange)),
    navigationPageSize: typeof params.pageSize === "number" ? String(params.pageSize) : undefined,
  };
}
function navigationResponseLogFields(envelope: FederationProtocolEnvelope): FederationEnvelopeLogFields {
  if (envelope.kind !== "response" || !envelope.result || typeof envelope.result !== "object") return {};
  const page = envelope.result as Record<string, unknown>;
  const coverage = page.coverage as Record<string, unknown> | undefined;
  return {
    navigationUnchanged: String(page.unchanged === true), navigationRangeUnchanged: String(Boolean(page.rangeUnchanged)),
    navigationComplete: String(page.complete === true), navigationNextCursor: String(Boolean(page.nextCursor)),
    navigationOwnerEpoch: typeof page.ownerEpoch === "string" ? fingerprint(page.ownerEpoch) : undefined,
    navigationGeneration: typeof page.generation === "string" ? fingerprint(page.generation) : undefined,
    navigationRangeStart: typeof page.rangeStart === "number" ? String(page.rangeStart) : undefined,
    navigationRevision: typeof page.countsRevision === "string" ? fingerprint(page.countsRevision) : undefined,
    navigationCoverage: ["complete", "checking", "degraded"].includes(String(coverage?.state)) ? String(coverage?.state) : undefined,
    navigationPendingProviders: typeof coverage?.pendingProviders === "number" ? String(coverage.pendingProviders) : undefined,
    navigationFailedProviders: typeof coverage?.failedProviders === "number" ? String(coverage.failedProviders) : undefined,
    navigationRows: Array.isArray(page.entries) ? String(page.entries.length) : undefined,
    navigationDirectories: Array.isArray(page.directories) ? String(page.directories.length) : undefined,
  };
}
