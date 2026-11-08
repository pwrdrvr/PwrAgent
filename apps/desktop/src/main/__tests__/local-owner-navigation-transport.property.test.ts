import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  FEDERATION_CAPABILITIES,
  FEDERATION_PROTOCOL_VERSION,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  type FederationRequestEnvelope,
  type NavigationQueryPage,
  type NavigationQueryRequest,
} from "@pwragent/shared";
import { FEDERATION_BACKEND_METHOD_CAPABILITIES } from "@pwragent/federation/federation-backend-methods";
import type { OwnerNavigationRequest } from "../../shared/owner-request";
import { LocalOwnerNavigationTransport } from "../federation/local-owner-navigation-transport";
import { registerNavigationBackendHandlers, type NavigationBackendOperations } from "../federation/federation-navigation-handlers";
import { FederationRouter } from "../federation/federation-router";
import { NavigationQueryPool } from "../app-server/navigation-query-pool";

const methods = ["backend.getNavigationQueryPage", "backend.getNavigationSelectedDetail",
  "backend.getNavigationQueueProjection", "backend.getNavigationLaunchpadConfig"] as const;
const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "owner",
  query: { kind: "lens", lens: "inbox" } };

function remote(backend: NavigationBackendOperations, method: typeof methods[number], params: unknown,
  capabilities = [...FEDERATION_CAPABILITIES], deadlineAt?: number) {
  const sent: unknown[] = [];
  const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
  router.registerConnection({ peerId: "peer", capabilities, sendEnvelope: (envelope) => sent.push(envelope) });
  registerNavigationBackendHandlers({ router, backend });
  const envelope: FederationRequestEnvelope = { id: "request", kind: "request", protocolVersion: FEDERATION_PROTOCOL_VERSION,
    sourceInstanceId: "peer", targetInstanceId: "owner", createdAt: Date.now(), deadlineAt, method, params };
  return { sent, result: router.routeEnvelope({ envelope, sourcePeerId: "peer" }) };
}

function backendFor(read: ReturnType<typeof vi.fn>): NavigationBackendOperations {
  return Object.fromEntries(methods.map((method) => [method.slice("backend.".length), read]));
}

describe("native and remote owner navigation dispatch", () => {
  it("returns the same owner result for every method while keeping demand context out of params", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...methods), fc.string(), async (method, identity) => {
      const response = { protocol: 2, revision: identity };
      const read = vi.fn(async (_request: unknown, _options: unknown) => response);
      const backend = backendFor(read);
      const local = new LocalOwnerNavigationTransport(backend);
      const params = { ...request, localConsumerId: "forged", requesterInstanceId: "forged" };
      expect(await local.request({ method, params } as OwnerNavigationRequest, identity)).toEqual(response);
      expect(read).toHaveBeenLastCalledWith(params, expect.objectContaining({ localConsumerId: identity }));
      const result = await remote(backend, method, params).result;
      expect(result).toMatchObject({ status: "handled", response: { result: response } });
      expect(read.mock.calls.at(-1)?.[1]).toEqual({ deadlineAt: undefined, requesterInstanceId: "peer" });
    }));
  });

  it("never lets payload claims grant local viewer inventory to a remote caller", async () => {
    await fc.assert(fc.asyncProperty(fc.string(), async (claim) => {
      const read = vi.fn(async () => ({ protocol: 2 }));
      const backend = backendFor(read);
      const params = { ...request, inventory: "viewer" as const, localConsumerId: claim,
        localContext: { consumerId: claim }, sourceInstanceId: "local-desktop-window" };
      expect(await remote(backend, methods[0], params).result).toMatchObject({ status: "rejected",
        message: "Viewer navigation inventory is available only on its local machine." });
      expect(read).not.toHaveBeenCalled();
      await new LocalOwnerNavigationTransport(backend).request({ method: methods[0], params }, claim);
      expect(read).toHaveBeenCalledOnce();
    }));
  });

  it("uses the capability table for every remote read even when the payload claims native trust", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...methods), fc.subarray([...FEDERATION_CAPABILITIES]), async (method, grants) => {
      const read = vi.fn(async () => ({ protocol: 2 }));
      const required = FEDERATION_BACKEND_METHOD_CAPABILITIES[method];
      const params = { ...request, localConsumerId: "native" };
      const result = await remote(backendFor(read), method, params, grants).result;
      expect(result.status).toBe(grants.includes(required) ? "handled" : "rejected");
      expect(read).toHaveBeenCalledTimes(grants.includes(required) ? 1 : 0);
    }));
  });

  it("refuses expired native demand before running the owner", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (age) => {
      const read = vi.fn();
      const local = new LocalOwnerNavigationTransport(backendFor(read));
      await expect(local.request({ method: methods[0], params: { ...request, deadlineAt: Date.now() - age } }, "expired"))
        .rejects.toMatchObject({ code: "navigation_busy" });
      expect(read).not.toHaveBeenCalled();
    }));
  });

  it("preserves the shared pool's byte budget and native typed failure without sending its cause over the wire", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), async (overage) => {
      const pool = new NavigationQueryPool();
      const backend: NavigationBackendOperations = { getNavigationQueryPage: async (query, options) => {
        const consumerId = options?.localConsumerId ?? "remote";
        try {
          return await pool.read({ consumerId, request: query, load: async () => ({
            protocol: 2, payload: "x".repeat(NAVIGATION_QUERY_MAX_RESULT_BYTES + overage),
          }) as unknown as NavigationQueryPage });
        } finally { pool.release(consumerId); }
      } };
      await expect(new LocalOwnerNavigationTransport(backend).request({ method: methods[0], params: request }, "local"))
        .rejects.toMatchObject({ code: "navigation_item_too_large" });
      const wire = remote(backend, methods[0], request);
      expect(await wire.result).toMatchObject({ status: "rejected", code: "handler_failed" });
      expect(wire.sent).toEqual([expect.objectContaining({ kind: "error", error: {
        code: "handler_failed", message: "[navigation_item_too_large] Navigation page exceeds its result budget.",
      } })]);
      expect(JSON.stringify(wire.sent)).not.toContain("cause");
    }), { numRuns: 10 });
  });

  it("admits only the four registered owner reads", async () => {
    const read = vi.fn();
    const local = new LocalOwnerNavigationTransport(backendFor(read));
    await fc.assert(fc.asyncProperty(fc.string().filter((method) => !methods.includes(method as typeof methods[number])), async (method) => {
      await expect(local.request({ method, params: request } as OwnerNavigationRequest, "window"))
        .rejects.toBeInstanceOf(Error);
      expect(read).not.toHaveBeenCalled();
    }));
  });
});
