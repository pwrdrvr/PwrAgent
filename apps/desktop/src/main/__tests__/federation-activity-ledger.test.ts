import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { FederationActivityLedger } from "../federation/federation-activity-ledger";

const base = {
  peerId: "gateway", localInstanceId: "local", direction: "sent" as const,
  byteCount: 116, dataByteCount: 100,
  envelope: { kind: "request" as const, sourceInstanceId: "local", targetInstanceId: "remote" },
  at: 1_000,
};

describe("Federation activity ledger", () => {
  it("counts request, successful/error responses, notifications and blobs in both directions exactly", () => {
    const ledger = new FederationActivityLedger(0);
    for (const direction of ["sent", "received"] as const) {
      for (const kind of ["request", "response", "error", "notification", "blob_chunk"] as const) {
        ledger.record({ ...base, direction, envelope: { ...base.envelope, kind } });
      }
    }
    const snapshot = ledger.snapshot(1_000);
    for (const direction of ["sent", "received"] as const) {
      expect(snapshot.physical.lifetime[direction]).toEqual({
        requests: 1, responses: 2, notifications: 1, other: 1, dataBytes: 500, wireBytes: 580,
      });
    }
    expect(snapshot.peers[0].series.lifetime).toEqual(snapshot.physical.lifetime);
  });

  it("attributes endpoint traffic to its logical peer while keeping physical gateway traffic separate", () => {
    const ledger = new FederationActivityLedger(0);
    ledger.record(base);
    ledger.record({ ...base, direction: "received", envelope: {
      kind: "response", sourceInstanceId: "remote", targetInstanceId: "local",
    } });
    const snapshot = ledger.snapshot(1_000);
    expect(snapshot.peers.map((peer) => peer.peerId)).toEqual(["gateway"]);
    expect(snapshot.logical.map((peer) => peer.peerId)).toEqual(["remote"]);
    expect(snapshot.logical[0].series.lifetime).toEqual(snapshot.physical.lifetime);
    expect(snapshot.physical.lifetime.sent.requests).toBe(1);
  });

  it("counts both physical relay hops but no transit traffic as local endpoint traffic", () => {
    const ledger = new FederationActivityLedger(0);
    const envelope = { kind: "request" as const, sourceInstanceId: "client", targetInstanceId: "remote" };
    ledger.record({ ...base, peerId: "client", direction: "received", envelope });
    ledger.record({ ...base, peerId: "remote", direction: "sent", envelope });
    const snapshot = ledger.snapshot(1_000);
    expect(snapshot.physical.lifetime.sent.requests).toBe(1);
    expect(snapshot.physical.lifetime.received.requests).toBe(1);
    expect(snapshot.logical).toEqual([]);
    expect(snapshot.peers).toHaveLength(2);
  });

  it("counts broadcast deliveries on receiving endpoints, excluding forwarding sends", () => {
    const ledger = new FederationActivityLedger(0);
    const envelope = { kind: "notification" as const, sourceInstanceId: "remote" };
    ledger.record({ ...base, direction: "received", envelope });
    ledger.record({ ...base, direction: "sent", peerId: "leaf", envelope });
    const snapshot = ledger.snapshot(1_000);
    expect(snapshot.logical[0].series.lifetime.received.notifications).toBe(1);
    expect(snapshot.logical[0].series.lifetime.sent.notifications).toBe(0);
  });

  it("expires rolling buckets at second boundaries and retains process totals through long idle periods", () => {
    const ledger = new FederationActivityLedger(0);
    ledger.record(base);
    expect(ledger.snapshot(60_999).physical.windows["1m"].sent.requests).toBe(1);
    expect(ledger.snapshot(61_000).physical.windows["1m"].sent.requests).toBe(0);
    expect(ledger.snapshot(300_000).physical.windows["5m"].sent.requests).toBe(1);
    expect(ledger.snapshot(301_000).physical.windows["5m"].sent.requests).toBe(0);
    expect(ledger.snapshot(600_000).physical.windows["10m"].sent.requests).toBe(1);
    expect(ledger.snapshot(601_000).physical.windows["10m"].sent.requests).toBe(0);
    const expired = ledger.snapshot(3_601_000);
    expect(expired.physical.windows["1h"].sent.requests).toBe(0);
    expect(expired.physical.lifetime.sent.requests).toBe(1);
    expect(expired.physical.history.every((point) => point.totals.sent.requests === 0)).toBe(true);
    expect(ledger.snapshot(9_000_000).peers[0].series.lifetime.sent.wireBytes).toBe(116);
  });

  it("handles mixed uncompressed, encrypted and simulated compressed frames independently", () => {
    const ledger = new FederationActivityLedger(0);
    for (const byteCount of [100, 116, 36]) ledger.record({ ...base, byteCount });
    const snapshot = ledger.snapshot(1_000);
    expect(snapshot.physical.lifetime.sent.dataBytes).toBe(300);
    expect(snapshot.physical.lifetime.sent.wireBytes).toBe(252);
    expect(snapshot.physical.lifetime.sent.requests).toBe(3);
  });

  it("bounds history and peer cardinality while overflow and lifetime counters retain every event", () => {
    const ledger = new FederationActivityLedger(0);
    for (let index = 1; index <= 8_000; index += 1) {
      ledger.record({ ...base, at: index * 1_000, peerId: `peer-${index}`,
        envelope: { ...base.envelope, targetInstanceId: `target-${index}` } });
    }
    const snapshot = ledger.snapshot(8_000_000);
    expect(snapshot.physical.lifetime.sent.requests).toBe(8_000);
    expect(snapshot.physical.windows["1h"].sent.requests).toBe(3_600);
    expect(snapshot.physical.history).toHaveLength(360);
    expect(snapshot.peers).toHaveLength(33);
    expect(snapshot.logical).toHaveLength(33);
    expect(snapshot.peers.reduce((sum, peer) => sum + peer.series.lifetime.sent.requests, 0)).toBe(8_000);
    // Numeric bucket retention remains bounded even without snapshot polling.
    const internals = ledger as unknown as {
      physical: { times: Float64Array; values: Float64Array };
      peers: Map<string, { times: Float64Array; values: Float64Array }>;
    };
    for (const series of [internals.physical, ...internals.peers.values()]) {
      expect(series.times).toHaveLength(3_600);
      expect(series.values).toHaveLength(3_600 * 12);
      expect(series.times.byteLength + series.values.byteLength).toBe(374_400);
    }
    expect(JSON.stringify(snapshot).length).toBeLessThan(180_000);
  });

  it("returns independent copies, retains no payloads, and only returns requested peer history", () => {
    const ledger = new FederationActivityLedger(0);
    const envelope = { ...base.envelope, params: { secret: "private payload" } };
    ledger.record({ ...base, envelope });
    const snapshot = ledger.snapshot(1_000, { historyView: "logical", historyPeerId: "remote" });
    expect(snapshot.physical.history).toHaveLength(0);
    expect(snapshot.peers[0].series.history).toHaveLength(0);
    expect(snapshot.logical[0].series.history).toHaveLength(360);
    expect(inspect(ledger, { depth: 12 })).not.toContain("private payload");
    snapshot.physical.lifetime.sent.requests = 9_999;
    expect(ledger.snapshot(1_000, { includeHistory: false }).physical.lifetime.sent.requests).toBe(1);
  });
  it("bounds remote metadata lengths instead of retaining payload-sized endpoint IDs", () => {
    const ledger = new FederationActivityLedger(0);
    ledger.record({ ...base, envelope: { ...base.envelope, targetInstanceId: "x".repeat(1_000_000) } });
    const snapshot = ledger.snapshot(1_000, { includeHistory: false });
    expect(snapshot.logical[0].peerId).toBe("Unknown endpoint");
    expect(inspect(ledger, { depth: 12 })).not.toContain("x".repeat(121));
  });

  it("tracks lifetime uncompressed sizes by direction and kind using the same attribution rules", () => {
    const ledger = new FederationActivityLedger(0);
    ledger.record({ ...base, dataByteCount: 1_000, byteCount: 100 });
    ledger.record({ ...base, dataByteCount: 3_000, byteCount: 100 });
    for (const kind of ["response", "error"] as const) {
      ledger.record({ ...base, direction: "received", dataByteCount: 50_000_000, byteCount: 500,
        envelope: { kind, sourceInstanceId: "remote", targetInstanceId: "local" } });
    }
    ledger.record({ ...base, dataByteCount: 500_000, envelope: { ...base.envelope, kind: "notification" } });
    // Relayed response: visible physically, excluded from this gateway's logical endpoint view.
    ledger.record({ ...base, direction: "received", dataByteCount: 100, envelope: {
      kind: "response", sourceInstanceId: "transit", targetInstanceId: "elsewhere",
    } });
    const snapshot = ledger.snapshot(10_000_000);
    expect(snapshot.physical.windows["1h"].sent.requests).toBe(0);
    expect(snapshot.physical.sizes.sent.requests).toMatchObject({ count: 2, averageBytes: 2_000, minBytes: 1_000, maxBytes: 3_000 });
    expect(snapshot.physical.sizes.sent.responses).toEqual({ count: 0 });
    expect(snapshot.physical.sizes.received.responses.count).toBe(3);
    expect(snapshot.logical[0].series.sizes.received.responses).toEqual({
      count: 2, averageBytes: 50_000_000, p50Bytes: 50_000_000, minBytes: 50_000_000, maxBytes: 50_000_000,
    });
    expect(snapshot.peers[0].series.sizes).toEqual(snapshot.physical.sizes);
  });

});


it("reset clears all history, peers and size distributions and starts a fresh measurement interval", () => {
  const ledger = new FederationActivityLedger(0);
  ledger.record(base);
  const previous = ledger.snapshot(1_000);
  ledger.reset(2_000);
  const cleared = ledger.snapshot(2_000);
  expect(cleared.since).toBe(2_000);
  expect(cleared.peers).toEqual([]);
  expect(cleared.logical).toEqual([]);
  expect(cleared.physical.lifetime.sent.requests).toBe(0);
  expect(cleared.physical.sizes.sent.requests).toEqual({ count: 0 });
  expect(cleared.physical.history.every((bucket) => bucket.totals.sent.dataBytes === 0)).toBe(true);
  for (const totals of Object.values(cleared.physical.windows)) expect(totals.sent.requests).toBe(0);
  expect(previous.physical.lifetime.sent.requests).toBe(1);
  ledger.record({ ...base, at: 3_000, dataByteCount: 50 });
  const next = ledger.snapshot(3_000);
  expect(next.physical.lifetime.sent.requests).toBe(1);
  expect(next.physical.sizes.sent.requests).toEqual({ count: 1, averageBytes: 50, p50Bytes: 50, minBytes: 50, maxBytes: 50 });
});


it("caps all numeric storage at 28.73 MB even when every peer and size histogram is populated", () => {
  const ledger = new FederationActivityLedger(0);
  function retainedBytes(value: unknown): number {
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof Map) return [...value.values()].reduce((sum, item) => sum + retainedBytes(item), 0);
    if (value && typeof value === "object") return Object.values(value).reduce<number>((sum, item) => sum + retainedBytes(item), 0);
    return 0;
  }
  for (let second = 0; second < 7_200; second += 1) {
    for (let peer = 0; peer < 40; peer += 1) {
      for (const direction of ["sent", "received"] as const) {
        for (const kind of ["request", "response"] as const) ledger.record({ ...base, at: second * 1_000,
          peerId: `peer-${peer}`, direction, envelope: { kind,
            sourceInstanceId: direction === "sent" ? "local" : `peer-${peer}`,
            targetInstanceId: direction === "sent" ? `peer-${peer}` : "local" },
        });
      }
    }
    if (second === 0 || second === 3_599 || second === 7_199) expect(retainedBytes(ledger)).toBe(28_725_312);
  }
  const snapshot = ledger.snapshot(7_199_000);
  expect(snapshot.physical.lifetime.sent.requests).toBe(7_200 * 40);
  expect(snapshot.physical.windows["1h"].sent.requests).toBe(3_600 * 40);
  expect(snapshot.physical.history.every((bucket) => bucket.totals.sent.requests === 400)).toBe(true);
  ledger.reset();
  expect(retainedBytes(ledger)).toBe(0);
});
