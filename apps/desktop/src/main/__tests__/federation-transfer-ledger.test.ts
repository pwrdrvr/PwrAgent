import { describe, expect, it } from "vitest";
import { FederationTransferLedger } from "../federation/federation-transfer-ledger";

describe("federation transfer ledger", () => {
  it("accumulates per-peer directional byte and envelope counts", () => {
    const ledger = new FederationTransferLedger();

    ledger.record({
      peerId: "pwr_studio",
      direction: "sent",
      byteCount: 1_000,
      at: 1_000,
    });
    ledger.record({
      peerId: "pwr_studio",
      direction: "received",
      byteCount: 200_000_000,
      at: 2_000,
    });
    ledger.record({
      peerId: "pwr_studio",
      direction: "received",
      byteCount: 500,
      at: 3_000,
    });
    ledger.record({
      peerId: "pwr_rack",
      direction: "sent",
      byteCount: 42,
      at: 4_000,
    });

    expect(ledger.snapshot("pwr_studio")).toEqual({
      bytesSent: 1_000,
      bytesReceived: 200_000_500,
      envelopesSent: 1,
      envelopesReceived: 2,
      since: 1_000,
      lastActivityAt: 3_000,
    });
    expect(ledger.snapshot("pwr_rack")).toEqual({
      bytesSent: 42,
      bytesReceived: 0,
      envelopesSent: 1,
      envelopesReceived: 0,
      since: 4_000,
      lastActivityAt: 4_000,
    });
  });

  it("returns nothing for peers with no observed activity", () => {
    const ledger = new FederationTransferLedger();

    expect(ledger.snapshot("pwr_idle")).toBeUndefined();
  });

  it("hands out copies, not live counter objects", () => {
    const ledger = new FederationTransferLedger();
    ledger.record({
      peerId: "pwr_studio",
      direction: "sent",
      byteCount: 10,
      at: 1_000,
    });

    const snapshot = ledger.snapshot("pwr_studio")!;
    snapshot.bytesSent = 999;

    expect(ledger.snapshot("pwr_studio")?.bytesSent).toBe(10);
  });
  it("bounds the legacy health-only peer map", () => {
    const ledger = new FederationTransferLedger();
    for (let index = 0; index < 129; index += 1) {
      ledger.record({ peerId: `peer-${index}`, direction: "sent", byteCount: 1, at: index });
    }
    expect(ledger.snapshot("peer-0")).toBeUndefined();
    expect(ledger.snapshot("peer-128")?.bytesSent).toBe(1);
  });

});
