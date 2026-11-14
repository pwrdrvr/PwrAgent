import { describe, expect, it, vi } from "vitest";
import { FEDERATION_BACKEND_METHODS } from "@pwragent/federation/federation-backend-methods";
import {
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";

type Handler = (envelope: { sourceInstanceId: string; params: unknown }) => Promise<unknown>;

/** Captures each registered handler; every other router call is inert. */
function captureHandlers(): { router: never; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const router = new Proxy({}, {
    get: (_target, property) => property === "registerHandler"
      ? (method: string, handler: Handler) => handlers.set(method, handler)
      : () => undefined,
  });
  return { router: router as never, handlers };
}

describe("federated turn input sender", () => {
  const thread = { backend: "claude" as const, threadId: "t1" };

  it("records the authenticated sender of a start, a steer and an active-turn steer, not the request's claims", async () => {
    const { router, handlers } = captureHandlers();
    const onTurnInputAccepted = vi.fn();
    const backend = {
      startTurn: async () => ({ ...thread, turnId: "u1" }),
      steerTurn: async () => ({ ...thread, turnId: "u1", disposition: "queued", queueEntryId: "q1" }),
      controlActiveTurn: async () => ({ ok: true, ...thread, requestId: "r1", turnId: "u1", disposition: "steered" }),
    } as unknown as FederationBackendOperations;
    registerFederationBackendHandlers({ router, backend, onTurnInputAccepted });

    await handlers.get(FEDERATION_BACKEND_METHODS.startTurn)!({
      sourceInstanceId: "m5", params: { ...thread, input: [], sourceInstanceId: "forged" },
    });
    await handlers.get(FEDERATION_BACKEND_METHODS.steerTurn)!({ sourceInstanceId: "m3", params: { ...thread, input: [] } });
    await handlers.get(FEDERATION_BACKEND_METHODS.controlActiveTurn)!({
      sourceInstanceId: "m7", params: { ...thread, requestId: "r1", operation: "steer", input: [] },
    });
    await handlers.get(FEDERATION_BACKEND_METHODS.controlActiveTurn)!({
      sourceInstanceId: "m9", params: { ...thread, requestId: "r2", operation: "stop" },
    });

    expect(onTurnInputAccepted.mock.calls).toEqual([
      ["m5", thread, { kind: "turn", turnId: "u1" }],
      ["m3", thread, { kind: "queued", queueEntryId: "q1" }],
      ["m7", thread, { kind: "turn", turnId: "u1" }],
    ]);
  });

  it("returns the owner's response even when recording the sender throws", async () => {
    const { router, handlers } = captureHandlers();
    const response = { ...thread, turnId: "u1" };
    registerFederationBackendHandlers({
      router,
      backend: { startTurn: async () => response } as unknown as FederationBackendOperations,
      onTurnInputAccepted: () => { throw new Error("bookkeeping"); },
    });
    await expect(handlers.get(FEDERATION_BACKEND_METHODS.startTurn)!({
      sourceInstanceId: "m5", params: { ...thread, input: [] },
    })).resolves.toBe(response);
  });
});
