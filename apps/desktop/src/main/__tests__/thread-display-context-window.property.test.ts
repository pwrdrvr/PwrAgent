import fc from "fast-check";
import { expect, it } from "vitest";
import type { AppServerReadThreadRequest, AppServerReadThreadResponse } from "@pwragent/shared";
import { projectThreadDisplay } from "../app-server/thread-display";
import {
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";

type ContextWindow = NonNullable<AppServerReadThreadResponse["replay"]["contextWindow"]>;

function connectThreadViewer(readThread: (request: AppServerReadThreadRequest) => AppServerReadThreadResponse) {
  const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
  const rpc = new FederationRpcEndpoint({
    localInstanceId: "viewer", remoteInstanceId: "owner",
    sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope, sourcePeerId: "viewer" }); },
  });
  router.registerConnection({ peerId: "viewer", capabilities: ["thread_detail"], sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
  registerFederationBackendHandlers({
    router,
    backend: { readThread: async (request: AppServerReadThreadRequest) => projectThreadDisplay(readThread(request), request) } as FederationBackendOperations,
  });
  return new FederationRemoteBackendClient(rpc);
}

async function expectViewerToRecoverOwnerContext(first: ContextWindow, later: ContextWindow) {
  const owner: AppServerReadThreadResponse = {
    backend: "claude", threadId: "thread-1", fetchedAt: 1,
    replay: { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false }, contextWindow: first },
  };
  const viewer = connectThreadViewer(() => owner);
  const request: AppServerReadThreadRequest = {
    backend: owner.backend, threadId: owner.threadId, limit: 20,
    display: { resource: "transcript", deferActivityDetails: true },
  };

  // A viewer with only thread_detail access has never seen the owner's live usage events.
  const initial = await viewer.readThread({ ...request, knownRevision: "" });
  expect(initial.replay.contextWindow).toEqual(first);
  expect((await viewer.readThread({ ...request, knownRevision: initial.replayRevision })).unchanged).toBe(true);

  // The meter can be the only thing that changes between two owner reads.
  owner.replay.contextWindow = later;
  const updated = await viewer.readThread({ ...request, knownRevision: initial.replayRevision });
  expect(updated.unchanged).toBeUndefined();
  expect(updated.replay.contextWindow).toEqual(later);
}

it("restores a saved 58% Claude reading to a snapshot-only viewer and refreshes it after compaction", async () => {
  await expectViewerToRecoverOwnerContext(
    { usedTokens: 580_000, modelContextWindow: 1_000_000 },
    { usedTokens: 45_000, modelContextWindow: 1_000_000 },
  );
});

it("round-trips the owner's last good context reading regardless of occupancy and window size", async () => {
  await fc.assert(fc.asyncProperty(
    fc.record({ usedTokens: fc.nat(2_000_000), modelContextWindow: fc.integer({ min: 1, max: 2_000_000 }) }),
    fc.integer({ min: 1, max: 200_000 }),
    async (first, change) => {
      await expectViewerToRecoverOwnerContext(first, { ...first, usedTokens: first.usedTokens + change });
    },
  ), { numRuns: 40 });
});
