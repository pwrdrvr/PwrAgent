import type { FederationProtocolEnvelope } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FederationRpcEndpoint } from "../federation/federation-rpc";

afterEach(() => {
  vi.useRealTimers();
});

describe("FederationRpcEndpoint", () => {
  it("releases cancelled query requests and ignores their late responses", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const endpoint = new FederationRpcEndpoint({
      localInstanceId: "client_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
    });
    const controller = new AbortController();
    const pending = endpoint.request({
      method: "backend.getNavigationQueryPage",
      params: {},
      signal: controller.signal,
    });
    controller.abort(new Error("Last window closed"));
    await expect(pending).rejects.toThrow("Last window closed");
    expect((endpoint as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
    expect(sent[0]).not.toHaveProperty("signal");
    expect(endpoint.receiveEnvelope({
      id: "late",
      protocolVersion: 1,
      kind: "response",
      requestId: sent[0]!.id,
      sourceInstanceId: "owner_one",
      targetInstanceId: "client_one",
      createdAt: 1,
      result: {},
    })).toBe(false);
  });

  it("rejects and removes a request when its route fails synchronously", async () => {
    const endpoint = new FederationRpcEndpoint({
      localInstanceId: "client_one",
      remoteInstanceId: "gateway_one",
      sendEnvelope: () => {
        throw new Error("Federation peer gateway_one is not connected.");
      },
    });

    await expect(endpoint.request({
      method: "backend.getNavigationSnapshot",
      params: {},
    })).rejects.toThrow("Federation peer gateway_one is not connected.");
    expect(
      (endpoint as unknown as { pending: Map<string, unknown> }).pending.size,
    ).toBe(0);
  });

  it("uses an absolute deadline for the wire envelope and pending timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: FederationProtocolEnvelope[] = [];
    const endpoint = new FederationRpcEndpoint({
      localInstanceId: "client_one",
      remoteInstanceId: "gateway_one",
      sendEnvelope: (envelope) => sent.push(envelope),
    });

    const request = endpoint.request({
      method: "backend.listThreads",
      params: {},
      deadlineAt: 1_025,
    });
    const rejection = request.catch((error: unknown) => error);

    expect(sent[0]).toMatchObject({ deadlineAt: 1_025 });
    expect(
      (endpoint as unknown as { pending: Map<string, unknown> }).pending.size,
    ).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    await expect(rejection).resolves.toMatchObject({
      message: "Federation request timed out: backend.listThreads",
    });
    expect(
      (endpoint as unknown as { pending: Map<string, unknown> }).pending.size,
    ).toBe(0);
  });

  it("does not send a request after its shared deadline has expired", async () => {
    const sendEnvelope = vi.fn();
    const endpoint = new FederationRpcEndpoint({
      localInstanceId: "client_one",
      remoteInstanceId: "gateway_one",
      now: () => 1_000,
      sendEnvelope,
    });

    await expect(endpoint.request({
      method: "backend.getNavigationSnapshot",
      params: {},
      deadlineAt: 1_000,
    })).rejects.toThrow(
      "Federation request timed out: backend.getNavigationSnapshot",
    );
    expect(sendEnvelope).not.toHaveBeenCalled();
    expect(
      (endpoint as unknown as { pending: Map<string, unknown> }).pending.size,
    ).toBe(0);
  });
});
