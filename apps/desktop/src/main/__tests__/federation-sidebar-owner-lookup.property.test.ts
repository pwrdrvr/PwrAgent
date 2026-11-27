import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { FEDERATION_PROTOCOL_VERSION, formatFederationPeerTargetLabels, type FederationPeerSummary, type FederationProtocolEnvelope } from "@pwragent/shared/contracts/federation";
import type { NavigationQueryPage } from "@pwragent/shared/contracts/navigation";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { replacementPages } from "../federation/federation-replacement-pages";
import { FederationRouter } from "../federation/federation-router";

const page: NavigationQueryPage = { protocol: 2, queryKey: "inbox", generation: "gen", ownerEpoch: "epoch",
  countsRevision: "rev", coverage: { state: "complete" }, counts: { total: 0, unread: 0, active: 0, review: 0 },
  entries: [], complete: true };

function fixture(count: number, legacy = false) {
  const runtime = new DesktopFederationRuntime();
  const viewer = "viewer";
  const router = new FederationRouter({ localInstanceId: viewer });
  const stored = new Map<string, FederationPeerSummary>();
  const harness = runtime as unknown as {
    receiveEnvelope(envelope: FederationProtocolEnvelope, source: string): Promise<void>;
    remotePeerDirectory: Map<string, FederationPeerSummary>;
    applyPeerDirectory(envelope: FederationProtocolEnvelope): boolean;
    visiblePeers(): FederationPeerSummary[];
    publishPeerStatus(id: string, status: FederationPeerSummary["status"]): void;
  };
  const listPeers = vi.fn(() => [...stored.values()]);
  const getPeer = vi.fn((id: string) => stored.get(id));
  const listConnections = vi.spyOn(router, "listConnections");
  Object.assign(runtime, { router, localInstanceId: viewer, store: () => ({ getPeer, listPeers }),
    defaultPeerLabel: (id: string) => id, defaultPeerRole: () => "client",
    celestialAssignments: new Map(), shortNames: { shortLabelFor: () => undefined }, restoreRemoteThreadPins: async () => {} });
  const send = vi.fn((wire: FederationProtocolEnvelope) => {
    if (wire.kind === "request") void harness.receiveEnvelope({ protocolVersion: FEDERATION_PROTOCOL_VERSION, kind: "response",
      id: "response", sourceInstanceId: wire.targetInstanceId!, targetInstanceId: viewer, createdAt: 1,
      requestId: wire.id, result: page }, wire.targetInstanceId!);
  });
  for (let i = 0; i < count; i++) {
    const id = `owner-${i}`;
    stored.set(id, { id, label: `Host ${i >> 1}`, role: "client", status: "connected", capabilities: ["thread_navigation"],
      profileName: legacy && i % 2 === 0 ? undefined : "default", navigationQueryProtocol: 2 });
    router.registerConnection({ peerId: id, capabilities: ["thread_navigation"], navigationQueryProtocol: 2, sendEnvelope: send });
  }
  const read = (id: string) => runtime.remoteNavigationQueryPage({ scope: "remote", instanceId: id },
    { protocol: 2, consumer: "main-sidebar", pageSize: 8, query: { kind: "lens", lens: "inbox" } });
  return { runtime, harness, router, stored, listPeers, getPeer, listConnections, read, send };
}

it.each([8, 16, 32])("bounds protocol checks and owner metadata when reading a sidebar page from each of %i connected peers", async count => {
  const f = fixture(count, true);
  await f.read("owner-1");
  expect(f.listPeers).not.toHaveBeenCalled();
  expect(f.listConnections).not.toHaveBeenCalled();
  // Only a legacy peer may need the initial snapshot to disambiguate host labels.
  await f.read("owner-0");
  expect(f.listPeers.mock.calls.length).toBeLessThanOrEqual(1);
  expect(f.listConnections.mock.calls.length).toBeLessThanOrEqual(1);
  f.listPeers.mockClear();
  f.listConnections.mockClear();
  f.getPeer.mockClear();
  f.send.mockClear();
  for (let i = 0; i < count; i++) {
    const actual = await f.read(`owner-${i}`);
    expect(actual.remoteOwner?.instanceLabel).toBe(`Host ${i >> 1}${i % 2 === 0 ? " (profile unknown)" : ""}`);
  }
  expect(f.send).toHaveBeenCalledTimes(count);
  expect(f.listPeers).not.toHaveBeenCalled();
  expect(f.listConnections).not.toHaveBeenCalled();
  expect(f.getPeer.mock.calls.length).toBeLessThanOrEqual(count * 2);
});

it("matches a fresh peer directory through reconnects, relabeling and changes of route", () => {
  fc.assert(fc.property(fc.array(fc.record({
    i: fc.integer({ min: 0, max: 3 }), direct: fc.boolean(), enrolled: fc.boolean(), advertised: fc.boolean(),
    status: fc.constantFrom("connected" as const, "disconnected" as const, "revoked" as const), label: fc.constantFrom("One", "Two"),
    profileName: fc.constantFrom(undefined, "default", "dev"), protocol: fc.boolean(),
  }), { minLength: 3, maxLength: 14 }), edits => {
    const f = fixture(4, true);
    f.runtime.remoteNavigationOwner({ scope: "remote", instanceId: "owner-0" });
    for (const edit of edits) {
      const id = `owner-${edit.i}`;
      const record: FederationPeerSummary = { id, label: edit.label, role: "client", status: edit.status, celestialIcon: "sun",
        profileName: edit.profileName, capabilities: ["thread_navigation"], navigationQueryProtocol: edit.protocol ? 2 : undefined };
      if (edit.enrolled) f.stored.set(id, record);
      else f.stored.delete(id);
      if (edit.advertised) f.harness.remotePeerDirectory.set(id, { ...record, capabilities: ["thread_detail"], label: "Relay" });
      else f.harness.remotePeerDirectory.delete(id);
      if (edit.direct) f.router.registerConnection({ peerId: id, capabilities: ["thread_detail"],
        navigationQueryProtocol: edit.protocol ? undefined : 2, sendEnvelope: f.send });
      else f.router.unregisterConnection(id);
      f.harness.publishPeerStatus(id, edit.direct ? "connected" : edit.status);
      const visible = f.harness.visiblePeers();
      const connected = visible.filter(peer => peer.status === "connected");
      for (let i = 0; i < 4; i++) {
        const target = { scope: "remote" as const, instanceId: `owner-${i}` };
        const peer = visible.find(peer => peer.id === target.instanceId);
        const label = peer?.status === "connected" ? formatFederationPeerTargetLabels(peer, connected).label : target.instanceId;
        expect(f.runtime.remoteNavigationOwner(target)).toEqual({ instanceId: target.instanceId, instanceLabel: label,
          capabilities: peer?.capabilities ?? [], peerStatus: peer?.status ?? "connected", celestialIcon: peer?.celestialIcon });
        const validate = () => f.runtime.assertRemoteNavigationQueryProtocol(target);
        if (peer?.status === "connected" && peer.navigationQueryProtocol === 2) expect(validate).not.toThrow();
        else expect(validate).toThrow();
      }
    }
  }), { numRuns: 10 });
});

it("changes the legacy owner label only after the complete relayed directory arrives", () => {
  const f = fixture(1, true);
  const label = () => f.runtime.remoteNavigationOwner({ scope: "remote", instanceId: "owner-0" }).instanceLabel;
  const deliver = (params: unknown) => f.harness.applyPeerDirectory({ id: "directory", kind: "notification",
    method: "federation.peerDirectoryPage", params, protocolVersion: FEDERATION_PROTOCOL_VERSION,
    sourceInstanceId: "gateway", targetInstanceId: "viewer", createdAt: 1 });
  expect(label()).toBe("Host 0");
  const relayed = Array.from({ length: 101 }, (_, i) => ({ ...f.stored.get("owner-0")!, id: `relayed-${i}`,
    label: i === 0 ? "Host 0" : `Relay ${i}`, profileName: "default" }));
  const pages = replacementPages(relayed);
  expect(pages).toHaveLength(2);
  deliver(pages[0]);
  expect(label()).toBe("Host 0");
  deliver(pages[1]);
  expect(label()).toBe("Host 0 (profile unknown)");
  deliver(replacementPages([])[0]);
  expect(label()).toBe("Host 0");
});

it("excludes the viewer's own identity from remote protocol negotiation", () => {
  const f = fixture(0);
  f.router.registerConnection({ peerId: "viewer", capabilities: [], navigationQueryProtocol: 2, sendEnvelope: f.send });
  expect(() => f.runtime.assertRemoteNavigationQueryProtocol({ scope: "remote", instanceId: "viewer" })).toThrow();
});
