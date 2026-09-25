import { describe, expect, it, vi } from "vitest";
import { FEDERATION_SHUTDOWN_METHOD, type FederationProtocolEnvelope } from "@pwragent/shared";
import { FederationShutdown } from "../federation/federation-shutdown";
import { FederationRouter } from "../federation/federation-router";

function fixture() {
  const sent: FederationProtocolEnvelope[] = [];
  const legacySend = vi.fn();
  const connections = [
    { peerId: "client", capabilities: ["shutdown_notice"] as const, sendEnvelope: (e: FederationProtocolEnvelope) => { sent.push(e); } },
    { peerId: "legacy", capabilities: [] as const, sendEnvelope: legacySend },
  ];
  const changed = vi.fn();
  const shutdown = new FederationShutdown({
    instanceId: () => "gateway", connections: () => connections,
    label: () => "Test peer", changed, now: () => 100_000,
  });
  return { shutdown, sent, legacySend, changed, connections };
}

function announcement(params: unknown, sourceInstanceId = "client"): FederationProtocolEnvelope {
  return {
    id: "notice", kind: "notification", method: FEDERATION_SHUTDOWN_METHOD,
    protocolVersion: 1, createdAt: 200_000, sourceInstanceId,
    targetInstanceId: "gateway", params,
  };
}

const scheduled = {
  shutdownId: "shutdown-1", revision: 1, state: "scheduled", reason: "quit", deadlineAt: 210_000,
};

describe("Federation shutdown", () => {
  it("announces, pauses, and cancels once per transition without contacting legacy peers", () => {
    const { shutdown, sent, legacySend } = fixture();
    shutdown.begin(110_000);
    expect(shutdown.draining).toBe(true);
    shutdown.pause();
    shutdown.cancel();
    expect(shutdown.draining).toBe(false);
    expect(sent.map((e) => e.kind === "notification" && e.params)).toEqual([
      expect.objectContaining({ state: "scheduled", deadlineAt: 110_000, revision: 1 }),
      expect.objectContaining({ state: "scheduled", deadlineAt: null, revision: 2 }),
      expect.objectContaining({ state: "cancelled", revision: 3 }),
    ]);
    expect(legacySend).not.toHaveBeenCalled();
  });

  it("announces immediate quit without waiting for acknowledgments, even when a peer throws", () => {
    const { shutdown, connections, sent } = fixture();
    connections[0].sendEnvelope = () => { throw new Error("closed"); };
    expect(() => shutdown.exiting()).not.toThrow();
    connections[0].sendEnvelope = (e: FederationProtocolEnvelope) => { sent.push(e); };
    shutdown.connected("client");
    expect(sent).toEqual([expect.objectContaining({ params: expect.objectContaining({ state: "exiting", deadlineAt: 100_000 }) })]);
  });

  it("normalizes a remote clock and clears a paused notice on cancellation or reconnect", () => {
    const { shutdown, changed } = fixture();
    shutdown.receive(announcement(scheduled), "client");
    expect(shutdown.snapshot()).toEqual([expect.objectContaining({ label: "Test peer", deadlineAt: 110_000 })]);
    shutdown.receive(announcement({ ...scheduled, revision: 2, deadlineAt: null }), "client");
    expect(shutdown.snapshot()[0].deadlineAt).toBeNull();
    shutdown.receive(announcement(scheduled), "client");
    expect(changed).toHaveBeenCalledTimes(2);
    shutdown.receive(announcement({ ...scheduled, revision: 3, state: "cancelled" }), "client");
    expect(shutdown.snapshot()).toEqual([]);
    shutdown.receive(announcement(scheduled), "client");
    expect(shutdown.snapshot()).toEqual([]);
    shutdown.receive(announcement({ ...scheduled, shutdownId: "next" }), "client");
    shutdown.connected("client");
    expect(shutdown.peerDraining("client")).toBe(false);
  });

  it("rejects forged origins, malformed payloads, and unnegotiated notices", () => {
    const { shutdown, changed } = fixture();
    shutdown.receive(announcement(scheduled, "other"), "client");
    shutdown.receive(announcement(scheduled, "legacy"), "legacy");
    shutdown.receive(announcement({ ...scheduled, deadlineAt: "tomorrow" }), "client");
    shutdown.receive(announcement({ ...scheduled, revision: -1 }), "client");
    shutdown.receive({ ...announcement(scheduled), targetInstanceId: "other" }, "client");
    expect(changed).not.toHaveBeenCalled();
  });

  it("allows an in-flight request to complete while rejecting new and relayed requests, then resumes on cancel", async () => {
    let draining = false;
    let finish!: (value: string) => void;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway", isDraining: () => draining });
    router.registerConnection({ peerId: "client", capabilities: ["gateway_relay"], sendEnvelope: (e) => { replies.push(e); } });
    router.registerHandler("work", () => new Promise<string>((resolve) => { finish = resolve; }));
    const envelope = { id: "one", kind: "request" as const, method: "work", params: {}, protocolVersion: 1, sourceInstanceId: "client", createdAt: Date.now() };
    const running = router.routeEnvelope({ sourcePeerId: "client", envelope });
    draining = true;
    await expect(router.routeEnvelope({ sourcePeerId: "client", envelope: { ...envelope, id: "two" } })).resolves.toMatchObject({ status: "rejected", code: "instance_shutting_down" });
    await expect(router.routeEnvelope({ sourcePeerId: "client", envelope: { ...envelope, id: "relay", targetInstanceId: "other" } })).resolves.toMatchObject({ status: "rejected", code: "instance_shutting_down" });
    finish("done");
    await expect(running).resolves.toMatchObject({ status: "handled", response: { result: "done" } });
    draining = false;
    router.registerHandler("work", () => "resumed");
    await expect(router.routeEnvelope({ sourcePeerId: "client", envelope })).resolves.toMatchObject({ status: "handled", response: { result: "resumed" } });
  });
});
