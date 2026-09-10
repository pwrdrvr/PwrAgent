import { describe, expect, it, vi } from "vitest";
import type { AppServerReadThreadResponse, FederationProtocolEnvelope } from "@pwragent/shared";
import { materializeFederationThreadRead, projectFederationThreadRead } from "../federation/federation-thread-read";

import { FederationRemoteBackendClient, registerFederationBackendHandlers, FEDERATION_BACKEND_METHOD_CAPABILITIES, type FederationBackendOperations } from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";

function fixture(): AppServerReadThreadResponse {
  const message = { id: "user-1", role: "user" as const, text: "captured log line\n".repeat(30_000),
    parts: [{ type: "text" as const, text: "captured log line\n".repeat(30_000) }] };
  return { backend: "codex", threadId: "thread-1", fetchedAt: 100, replayRevision: "owner-revision",
    replay: { entries: [{ ...message, type: "message", phase: "final", turn: { id: "turn-1" } }],
      messages: [message], lastUserMessage: message.text,
      pagination: { supportsPagination: true, hasPreviousPage: true, previousCursor: "older-page" } } };
}

const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe("federation thread read projection", () => {
  it("materializes owner references before the client transforms transcript images", async () => {
    const response = fixture();
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "owner_one", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
    const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer_one", remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => { void router.routeEnvelope({ sourcePeerId: "viewer_one", envelope: wire(envelope) }); } });
    router.registerConnection({ peerId: "viewer_one", capabilities: ["thread_detail"], sendEnvelope: (envelope) => {
      replies.push(wire(envelope));
      rpc.receiveEnvelope(wire(envelope));
    } });
    registerFederationBackendHandlers({ router, backend: { readThread: async () => response } as unknown as FederationBackendOperations });
    const transform = vi.fn((read: AppServerReadThreadResponse) => read);
    const client = new FederationRemoteBackendClient(rpc, transform);
    const result = await client.readThread({ backend: "codex", threadId: "thread-1" });
    expect(result).toEqual(response);
    expect(transform).toHaveBeenCalledWith(response);
    expect(replies[0]).toMatchObject({ kind: "response", result: { replay: { messages: [{ entryIndex: 0 }] } } });
  });

  it("sends large messages once and restores the exact replay after JSON transport", () => {
    const response = fixture();
    const before = wire(response);
    const projected = projectFederationThreadRead(response);
    expect(materializeFederationThreadRead(wire(projected))).toEqual(before);
    expect(response).toEqual(before);
    expect(projected.replay.messages[0]).toMatchObject({ entryIndex: 0 });
    expect(projected.replay.lastUserMessage).toEqual({ messageIndex: 0 });
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(Buffer.byteLength(JSON.stringify(response)) * 0.5);
  });

  it("preserves standalone messages, mismatched content, optional fields and message order", () => {
    const response = fixture();
    const original = response.replay.messages[0];
    response.replay.messages = [
      { ...original, id: "standalone" },
      { ...original, text: "different content" },
      { ...original, parts: undefined },
      original,
    ];
    response.replay.lastAssistantMessage = "summary not present in page";
    expect(materializeFederationThreadRead(wire(projectFederationThreadRead(response)))).toEqual(wire(response));
  });

  it("keeps empty conditional responses and short messages intact", () => {
    const response = fixture();
    response.unchanged = true;
    response.replay = { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } };
    expect(projectFederationThreadRead(response)).toEqual(response);
    expect(materializeFederationThreadRead(wire(projectFederationThreadRead(response)))).toEqual(response);
  });

  it("rejects invalid references instead of returning an incomplete transcript", () => {
    for (const entryIndex of [-1, 999, 0.5]) {
      const projected = projectFederationThreadRead(fixture());
      projected.replay.messages = [{ entryIndex, fields: ["id", "role", "text"] }];
      expect(() => materializeFederationThreadRead(projected)).toThrow(/message reference/);
    }
    const projected = projectFederationThreadRead(fixture());
    projected.replay.messages = [{ entryIndex: 0, fields: ["id", "role", "text", "__proto__"] }];
    expect(() => materializeFederationThreadRead(projected)).toThrow(/message reference/);
    projected.replay.messages = [];
    expect(() => materializeFederationThreadRead(projected)).toThrow(/text reference/);
  });
});
