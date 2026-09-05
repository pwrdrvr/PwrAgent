import type {
  FederationInstanceId,
  FederationTransferStats,
} from "@pwragent/shared";

/**
 * Process-local wire-transfer accounting per directly connected peer.
 * Fed by the transport's envelope-frame taps (post-encryption byte
 * counts, so compression changes read as real wire savings) and read
 * by the health surface. Counters accumulate across reconnects within
 * one app run — the runtime keeps a single ledger across restarts of
 * the federation stack — and are deliberately never persisted: they
 * exist to answer "how much has this connection moved since launch",
 * the baseline-vs-optimized comparison an operator actually runs.
 */
export class FederationTransferLedger {
  private readonly byPeer = new Map<
    FederationInstanceId,
    FederationTransferStats
  >();

  record(params: {
    peerId: FederationInstanceId;
    direction: "sent" | "received";
    byteCount: number;
    at?: number;
  }): void {
    const at = params.at ?? Date.now();
    const stats = this.byPeer.get(params.peerId) ?? {
      bytesSent: 0,
      bytesReceived: 0,
      envelopesSent: 0,
      envelopesReceived: 0,
      since: at,
      lastActivityAt: at,
    };
    if (params.direction === "sent") {
      stats.bytesSent += params.byteCount;
      stats.envelopesSent += 1;
    } else {
      stats.bytesReceived += params.byteCount;
      stats.envelopesReceived += 1;
    }
    stats.lastActivityAt = at;
    // Health's legacy per-peer counters are bounded as well. The activity
    // ledger separately retains all process totals, including overflow peers.
    if (!this.byPeer.has(params.peerId) && this.byPeer.size >= 128) {
      this.byPeer.delete(this.byPeer.keys().next().value!);
    }
    this.byPeer.set(params.peerId, stats);
  }

  snapshot(peerId: FederationInstanceId): FederationTransferStats | undefined {
    const stats = this.byPeer.get(peerId);
    return stats ? { ...stats } : undefined;
  }
}
