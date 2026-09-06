import { describe, expect, it } from "vitest";
import type { FederationProtocolEnvelope } from "@pwragent/shared";
import { FederationEnvelopeDiagnostics } from "../federation/federation-envelope-diagnostics";

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
