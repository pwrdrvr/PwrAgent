import { describe, expect, it } from "vitest";
import type { FederationProtocolEnvelope } from "@pwragent/shared";
import { describeLargeBackendEvent, describeLargeThreadReadResult, FederationEnvelopeDiagnostics } from "../federation/federation-envelope-diagnostics";

const request = {
  kind: "request", id: "req", sourceInstanceId: "viewer", targetInstanceId: "owner",
  protocolVersion: 1, createdAt: 0,
  method: "backend.getNavigationSnapshot", params: { secret: "do not log" },
} satisfies FederationProtocolEnvelope;
const response = {
  kind: "response", id: "res", requestId: "req",
  sourceInstanceId: "owner", targetInstanceId: "viewer", result: { secret: "do not log" },
  protocolVersion: 1, createdAt: 0,
} satisfies FederationProtocolEnvelope;

describe("federation envelope diagnostics", () => {
  it("distinguishes full accounting notifications from stream patches using sizes only", () => {
    const toolAccounting = { invocations: [{ command: "private command", output: "private output" }] };
    const envelope = { ...request, kind: "notification", method: "backend.event", params: {
      backend: "codex", stream: { epoch: "epoch", sequence: 3 },
      notification: { method: "thread/toolAccounting/updated", params: { threadId: "thread-1", toolAccounting } },
    } } satisfies FederationProtocolEnvelope;
    const fields = describeLargeBackendEvent(envelope);
    expect(fields).toMatchObject({
      toolAccountingBytes: Buffer.byteLength(JSON.stringify(toolAccounting)), pricingBytes: 0, accountingPatchBytes: 0, streamSequence: 3,
    });
    expect(new FederationEnvelopeDiagnostics().describe(envelope)).toMatchObject({
      threadId: "thread-1", notificationMethod: "thread/toolAccounting/updated",
    });
    const accountingPatch = { baseSequence: 3, changes: [{ value: "private replacement" }] };
    const patched = describeLargeBackendEvent({ ...envelope, params: {
      ...envelope.params, accountingPatch,
      notification: { method: "thread/toolAccounting/updated", params: { threadId: "thread-1" } },
    } });
    expect(patched).toMatchObject({ toolAccountingBytes: 0, accountingPatchBytes: Buffer.byteLength(JSON.stringify(accountingPatch)) });
    expect(JSON.stringify([fields, patched])).not.toContain("private");
    expect(describeLargeBackendEvent(response)).toEqual({});
  });
  it("accounts for replay duplication and inline images without logging content", () => {
    const image = "data:image/png;base64," + "eA==".repeat(100);
    const message = { id: "message", text: "private transcript 🦀", parts: [{ type: "image", url: image }] };
    const entries = [{ ...message, type: "message" }];
    const messages = [message];
    const pricing = { lines: [{ private: "accounting", amount: 12 }] };
    const fields = describeLargeThreadReadResult({ ...response, result: {
      replay: { entries, messages, pagination: { hasMore: false } }, pricing,
    } });
    expect(fields).toMatchObject({
      replayEntryCount: 1, replayMessageCount: 1,
      replayEntriesBytes: Buffer.byteLength(JSON.stringify(entries)),
      replayMessagesBytes: Buffer.byteLength(JSON.stringify(messages)),
      pricingBytes: Buffer.byteLength(JSON.stringify(pricing)),
      inlineImageUrlCount: 2, inlineImageUrlBytes: 2 * Buffer.byteLength(image),
    });
    expect(Object.values(fields).every((value) => typeof value === "number")).toBe(true);
    expect(describeLargeThreadReadResult(response)).toEqual({});
    expect(describeLargeThreadReadResult(request)).toEqual({});
  });
  it("attributes large replay responses to their thread and bounded initiating surface", () => {
    const diagnostics = new FederationEnvelopeDiagnostics();
    diagnostics.observe({ ...request, method: "backend.readThread", params: {
      threadId: "thread-1", readReason: "star-map-card", text: "private content",
    } });
    expect(diagnostics.describe(response)).toMatchObject({
      threadId: "thread-1", readReason: "star-map-card", method: "backend.readThread",
    });
    expect(JSON.stringify(diagnostics.describe(response))).not.toContain("private content");
    diagnostics.observe({ ...request, id: "long", method: "backend.readThread", params: {
      threadId: "x".repeat(257), readReason: "private reason",
    } });
    expect(diagnostics.describe({ ...response, requestId: "long" })).toMatchObject({
      threadId: undefined, readReason: undefined,
    });
  });
  it("correlates search query fingerprints without logging query text", () => {
    const diagnostics = new FederationEnvelopeDiagnostics();
    const search = { ...request, method: "backend.searchNavigationThreads", params: { query: "private search phrase" } };
    diagnostics.observe(search);
    const fields = diagnostics.describe(search);
    expect(fields.queryFingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(diagnostics.describe(response).queryFingerprint).toBe(fields.queryFingerprint);
    expect(diagnostics.describe({ ...search, params: { query: "other phrase" } }).queryFingerprint).not.toBe(fields.queryFingerprint);
    expect(JSON.stringify(fields)).not.toContain("private search phrase");
  });

  it("correlates both relay legs without retaining or logging payloads", () => {
    const diagnostics = new FederationEnvelopeDiagnostics();
    diagnostics.observe(request);
    diagnostics.observe(request);
    diagnostics.observe(response);
    const fields = diagnostics.describe(response, (id) => `Friendly ${id}`);
    expect(fields).toMatchObject({
      method: "backend.getNavigationSnapshot", requestId: "req",
      sourceInstanceLabel: "Friendly owner", targetInstanceLabel: "Friendly viewer",
    });
    expect(diagnostics.describe(response)).toMatchObject({ method: request.method });
    expect(JSON.stringify(fields)).not.toContain("secret");
  });

  it("bounds correlation retention and does not confuse reversed owners", () => {
    let now = 0;
    const diagnostics = new FederationEnvelopeDiagnostics(() => now, 1, 100);
    diagnostics.observe(request);
    expect(diagnostics.describe({ ...response, sourceInstanceId: "other" } as FederationProtocolEnvelope).method).toBe("unknown");
    now = 101;
    expect(diagnostics.describe(response).method).toBe("unknown");
    diagnostics.observe(request);
    diagnostics.observe({ ...request, id: "second" });
    expect(diagnostics.describe(response).method).toBe("unknown");
  });

  it("identifies wrapped notifications and uncorrelated responses", () => {
    const diagnostics = new FederationEnvelopeDiagnostics();
    expect(diagnostics.describe({
      ...request, kind: "notification", method: "backend.event",
      params: { notification: { method: "thread/updated", params: { secret: true } } },
    } as FederationProtocolEnvelope)).toMatchObject({ method: "backend.event", notificationMethod: "thread/updated" });
    expect(diagnostics.describe(response)).toMatchObject({ method: "unknown", requestId: "req" });
  });

  it("correlates error responses and retains their error code", () => {
    const diagnostics = new FederationEnvelopeDiagnostics();
    diagnostics.observe(request);
    expect(diagnostics.describe({
      ...response, kind: "error", error: { code: "method_not_found", message: "private detail" },
    })).toMatchObject({
      method: request.method, requestId: "req", errorCode: "method_not_found",
    });
  });
});
