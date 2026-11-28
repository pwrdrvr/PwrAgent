import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FEDERATION_CAPABILITIES, type FederationCapability, type FederationConnectionState } from "../contracts/federation";
import {
  ownerTakesSettle,
  readSetThreadSettledRequest,
  readSettleDirectoryUnpinnedRequest,
  SETTLE_DIRECTORY_UNPINNED_MAX_THREADS,
  threadSettleOffered,
  threadSettleRefusal,
} from "../contracts/thread-settle";

/**
 * Who offers Settle. Settle is the owner's state, so a row offers it only
 * when its owner holds Settle (`thread_settle_snooze`) and lets this machine
 * change its sidebar (`thread_navigation`). A peer that is not connected
 * cannot answer, an older peer has no Settle, and a sub-thread is settled
 * with its root. In a peer's own window, that peer is the owner of every row.
 */

const STATES: FederationConnectionState[] = [
  "disabled", "listening", "connecting", "handshaking", "connected",
  "degraded", "rejected", "revoked", "disconnected",
];

const row = fc.record({
  sub: fc.constantFrom("root", "child", "native-sub-agent"),
  peer: fc.option(fc.record({
    status: fc.option(fc.constantFrom(...STATES), { nil: undefined }),
    capabilities: fc.option(fc.subarray([...FEDERATION_CAPABILITIES]), { nil: undefined }),
  }), { nil: undefined }),
  windowOwner: fc.option(fc.option(fc.subarray([...FEDERATION_CAPABILITIES]), { nil: undefined }), { nil: null }),
});

type Row = { sub: string; peer?: { status?: FederationConnectionState; capabilities?: FederationCapability[] };
  windowOwner: FederationCapability[] | undefined | null };

function thread(spec: Row) {
  return {
    ...(spec.sub === "child" ? { parentThreadId: "root" } : {}),
    ...(spec.sub === "native-sub-agent" ? { codexNativeSubAgent: { depth: 1 } as never } : {}),
    ...(spec.peer ? {
      federation: {
        ref: { instanceId: "peer", threadId: "t", backend: "codex" } as never,
        instanceLabel: "Peer",
        ...(spec.peer.status ? { peerStatus: spec.peer.status } : {}),
        ...(spec.peer.capabilities ? { capabilities: spec.peer.capabilities } : {}),
      },
    } : {}),
  };
}

/** The rule as a table, written without the implementation's helpers. */
function oracle(spec: Row): boolean {
  if (spec.sub !== "root") return false;
  const takes = (caps: FederationCapability[] | undefined) =>
    (caps ?? []).includes("thread_settle_snooze") && (caps ?? []).includes("thread_navigation");
  if (spec.windowOwner !== null) return takes(spec.windowOwner);
  if (!spec.peer) return true;
  return spec.peer.status === "connected" && takes(spec.peer.capabilities);
}

describe("Settle across federation", () => {
  it("offers Settle only where the owner holds it and grants navigation", () => {
    fc.assert(fc.property(row, (spec) => {
      const windowOwnerTakesSettle = spec.windowOwner === null ? undefined : ownerTakesSettle(spec.windowOwner);
      expect(threadSettleOffered(thread(spec as Row), windowOwnerTakesSettle)).toBe(oracle(spec as Row));
    }));
  });

  it("covers each corner of the matrix", () => {
    const both: FederationCapability[] = ["thread_settle_snooze", "thread_navigation"];
    expect(threadSettleOffered({})).toBe(true);
    expect(threadSettleOffered({ parentThreadId: "r" })).toBe(false);
    const peer = (peerStatus: FederationConnectionState, capabilities?: FederationCapability[]) => ({
      federation: { ref: {} as never, instanceLabel: "Peer", peerStatus, ...(capabilities ? { capabilities } : {}) },
    });
    expect(threadSettleOffered(peer("connected", both))).toBe(true);
    // An older peer, a peer that grants no navigation, and an offline peer.
    expect(threadSettleOffered(peer("connected", ["thread_navigation"]))).toBe(false);
    expect(threadSettleOffered(peer("connected", ["thread_settle_snooze"]))).toBe(false);
    expect(threadSettleOffered(peer("disconnected", both))).toBe(false);
    // A peer's window: its owner decides, even for a row with no federation.
    expect(threadSettleOffered({}, false)).toBe(false);
    expect(threadSettleOffered(peer("disconnected"), true)).toBe(true);
  });

  it("refuses Settle for sub-threads, working threads and queued sends", () => {
    expect(threadSettleRefusal({ parentThreadId: "r" })).toBe("subthread");
    expect(threadSettleRefusal({ threadStatus: "active" })).toBe("running");
    expect(threadSettleRefusal({ queuedTurns: [{}] } as never)).toBe("queued");
    expect(threadSettleRefusal({})).toBeUndefined();
  });

  it("reads only well-formed peer requests", () => {
    fc.assert(fc.property(fc.anything(), (value) => {
      const read = readSetThreadSettledRequest(value);
      if (read) {
        expect(typeof read.threadId).toBe("string");
        expect(typeof read.settled).toBe("boolean");
      }
      const bulk = readSettleDirectoryUnpinnedRequest(value);
      if (bulk) expect(typeof bulk.directoryKey).toBe("string");
    }));
    expect(readSetThreadSettledRequest({ threadId: "t", settled: true, backend: "codex", seenUpdatedAt: 5 }))
      .toEqual({ threadId: "t", settled: true, backend: "codex", seenUpdatedAt: 5 });
    expect(readSetThreadSettledRequest({ threadId: "t", settled: "yes" })).toBeUndefined();
    expect(readSetThreadSettledRequest({ threadId: "t", settled: true, backend: "nope" })).toBeUndefined();
    expect(readSetThreadSettledRequest({ threadId: "t", settled: true, seenUpdatedAt: -1 })).toBeUndefined();
    const threads = Array.from({ length: SETTLE_DIRECTORY_UNPINNED_MAX_THREADS + 1 }, (_, i) =>
      ({ backend: "codex", threadId: `t${i}` }));
    expect(readSettleDirectoryUnpinnedRequest({ directoryKey: "d", threads })).toBeUndefined();
    expect(readSettleDirectoryUnpinnedRequest({ directoryKey: "d", threads: threads.slice(1) })?.threads)
      .toHaveLength(SETTLE_DIRECTORY_UNPINNED_MAX_THREADS);
    expect(readSettleDirectoryUnpinnedRequest({ directoryKey: "d" })).toEqual({ directoryKey: "d" });
  });
});
