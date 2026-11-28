import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { FederationRouter, FederationRequestHandler } from "@pwragent/federation/federation-router";
import type { FactoryCpuRequest, FactoryCpuStatus } from "@pwragent/owner-core/resource-checkout-authority";
import { FEDERATION_PROTOCOL_VERSION, type FederationPeerSummary, type FederationRequestEnvelope } from "@pwragent/shared/contracts/federation";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import { FACTORY_CPU_FEDERATION_METHOD, registerFactoryCpuFederationHandler } from "../resource-checkouts/factory-cpu-federation";
import { readExternalCheckoutBindings } from "../resource-checkouts/checkout-configuration";
import { disposeResourceCheckouts, initializeResourceCheckouts } from "../resource-checkouts/checkout-runtime";
import { openFederationCheckoutStorage, openMachineCheckoutStorage } from "../storage/resource-checkout-storage";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const gateway = { instanceId: "cpu-test-gateway", machineId: "mach_00000000-0000-4000-8000-000000000001" };
const worker = { instanceId: "cpu-test-worker", machineId: "mach_00000000-0000-4000-8000-000000000002" };
const other = "cpu-other-gateway";
const workerAlias = "cpu-worker-alias";
const unapproved = "cpu-unapproved-gateway";
const resourceId = `machine:${worker.machineId}:cpu`;
const noPeer = async () => { throw new Error("No generic peer"); };

const consentKey = `factory-cpu:${worker.machineId}`;
const labKey = "external:fixture:lab";
const lab = {
  canonicalKey: labKey, displayName: "Fixture lab", kindLabel: "Lab",
  authorityMachineId: worker.machineId, authorityInstanceId: worker.instanceId,
  allowedInstances: [], capacity: 1, epoch: 1, revision: 1, updatedAt: 1, maxHoldMs: 60_000,
};

function consent(authorityMachineId = worker.machineId, authorityInstanceId = worker.instanceId) {
  return {
    ...lab, canonicalKey: `factory-cpu:${authorityMachineId}`,
    authorityMachineId, authorityInstanceId, allowedInstances: [gateway.instanceId, other],
  };
}

function loadBindings(root: string, domains: unknown[]) {
  writeFileSync(path.join(root, "resource-checkout-authorities.json"), JSON.stringify({ version: 1, domains }));
  return readExternalCheckoutBindings(root);
}

function rig(allowedInstances = consent().allowedInstances) {
  const { tempDir } = createTempStateDb("factory-physical-cpu-");
  let online = true;
  let now = 1_800_000_000_000;
  const workerConfig = loadBindings(tempDir, [{ ...consent(), allowedInstances }, lab]);
  // A copied external definition names the wrong owner. Only the worker's
  // live catalog can route this key.
  const gatewayConfig = loadBindings(tempDir, [consent(), { ...lab, authorityInstanceId: workerAlias }]);
  const machine = (instanceId: string) => new DesktopResourceCheckoutService({
    viewer: { ...worker, instanceId, profile: instanceId, instanceLabel: "Worker" },
    machineStore: openMachineCheckoutStorage(tempDir, worker.machineId),
    externalStore: instanceId === worker.instanceId ? openFederationCheckoutStorage(tempDir, worker.machineId) : undefined,
    ...workerConfig, machineCpuCount: 2, warn: () => {}, requestPeer: noPeer,
    peerConnected: () => online,
    now: () => now,
  });
  let receiver = machine(worker.instanceId);
  const alias = machine(workerAlias);
  const routes = new Map<string, FederationRequestHandler>();
  const enrollments = new Map<string, Pick<FederationPeerSummary, "status" | "permissionRole">>([
    [other, { status: "connected", permissionRole: "full" }],
    [unapproved, { status: "connected", permissionRole: "full" }],
  ]);
  const router: Pick<FederationRouter, "registerHandler" | "getConnection"> = {
    registerHandler: (method, handler) => { routes.set(method, handler); },
    getConnection: (peerId) => online ? { peerId, capabilities: [], sendEnvelope: () => {} } : undefined,
  };
  registerFactoryCpuFederationHandler({
    router,
    enrolledPeer: (id) => enrollments.get(id),
    pinnedGateway: () => gateway.instanceId,
    execute: (id, req) => receiver.receiveFactoryCpu(id, req),
  });
  const receive = (source: string, params: unknown, through = source) => {
    const envelope: FederationRequestEnvelope = {
      protocolVersion: FEDERATION_PROTOCOL_VERSION, kind: "request", id: randomUUID(),
      sourceInstanceId: source, targetInstanceId: worker.instanceId, createdAt: now,
      method: FACTORY_CPU_FEDERATION_METHOD, params,
    };
    return routes.get(FACTORY_CPU_FEDERATION_METHOD)!(envelope, through);
  };
  const rpc = vi.fn(async (id: string, req: FactoryCpuRequest) => {
    if (id !== worker.instanceId || !online) throw new Error("Selected machine authority is disconnected");
    return receive(gateway.instanceId, req) as FactoryCpuStatus | null;
  });
  const sender = new DesktopResourceCheckoutService({
    viewer: { ...gateway, profile: "gateway", instanceLabel: "Gateway" },
    ...gatewayConfig, warn: () => {}, requestFactoryCpu: rpc,
    checkoutPeers: () => new Map(online ? [[worker.instanceId, "connected" as const]] : []),
    requestPeer: async <T>(id: string, request: unknown) => {
      if (id !== worker.instanceId || !online) return noPeer();
      return receiver.receivePeer(gateway.instanceId, request) as T;
    },
  });
  return {
    sender, alias, enrollments, receive, rpc,
    get receiver() { return receiver; },
    goOffline: () => { online = false; },
    advance: (ms: number) => { now += ms; },
    restart: async () => { await receiver.close(); receiver = machine(worker.instanceId); },
    close: async () => {
      await Promise.all([sender.close(), receiver.close(), alias.close()]);
      removeTempStateDbDir(tempDir);
    },
  };
}

it("keeps manifest consent out of the live catalog and routes ordinary checkouts through the advertised owner", async () => {
  const h = rig();
  try {
    const discovered = await h.sender.discover(h.sender.threadActor("codex", "test-thread"));
    expect(discovered.some(({ resource }) => resource.resourceId === consentKey || resource.resourceId === resourceId)).toBe(false);
    expect(discovered.filter(({ resource }) => resource.resourceId === labKey)).toHaveLength(1);
    expect(await h.sender.perform({
      kind: "request", resourceId: labKey, idempotencyKey: "catalog-only", purpose: "Fixture", expectedDurationMs: 1_000,
    })).toMatchObject({ outcome: "granted" });
    expect(await h.sender.factoryCpu(reservation())).toMatchObject({ state: "granted" });
  } finally {
    await h.close();
  }
});

it("keeps explicit gateway consent required after loading the worker manifest", async () => {
  const h = rig([]);
  try {
    await expect(h.sender.factoryCpu(reservation())).rejects.toThrow("not approved");
    expect((await h.receiver.discover(h.receiver.threadActor("codex", "test-thread")))
      .find(({ resource }) => resource.resourceId === resourceId)?.resource.allocations).toEqual([]);
  } finally {
    await h.close();
  }
});

function reservation(): FactoryCpuRequest {
  return { action: "reserve", resourceId, requestId: randomUUID() };
}

it("starts the canonical machine ledger from a consent-only manifest", async () => {
  const { tempDir } = createTempStateDb("factory-physical-runtime-");
  vi.stubEnv("PWRAGENT_HOME", tempDir);
  vi.stubEnv("PWRAGENT_PROFILE", "fixture");
  try {
    writeFileSync(path.join(tempDir, "machine-id"), worker.machineId);
    writeFileSync(path.join(tempDir, "resource-checkout-authorities.json"), JSON.stringify({
      version: 1,
      domains: [{
        canonicalKey: consentKey, authorityMachineId: worker.machineId, authorityInstanceId: worker.instanceId,
        allowedInstances: [gateway.instanceId],
      }],
    }));
    let receive: Parameters<Parameters<typeof initializeResourceCheckouts>[0]["setFactoryCpuHandler"]>[0] | undefined;
    const federation = {
      resourceCheckoutInstanceId: () => worker.instanceId,
      resourceCheckoutPeers: () => new Map(),
      setResourceCheckoutHandler() {},
      setFactoryCpuHandler(handler: typeof receive) { receive = handler; },
      onPeerStatusChanged: () => () => {},
    } as unknown as Parameters<typeof initializeResourceCheckouts>[0];
    const service = await initializeResourceCheckouts(federation, undefined, false);
    expect(receive?.(gateway.instanceId, reservation())).toMatchObject({ state: "granted", resourceId });
    expect((await service.discover(service.threadActor("codex", "test-thread")))
      .find(({ resource }) => resource.resourceId === resourceId)?.resource.allocations).toHaveLength(1);
    expect(existsSync(path.join(tempDir, "resource-checkouts.db"))).toBe(true);
    expect(existsSync(path.join(tempDir, "federation-resource-checkouts.db"))).toBe(false);
  } finally {
    await disposeResourceCheckouts();
    vi.unstubAllEnvs();
    removeTempStateDbDir(tempDir);
  }
});

it("a peer cannot get a Factory slot when an ordinary grant on another profile fills the same machine", async () => {
  const h = rig();
  try {
    const saturated = await h.alias.perform({
      kind: "request", resourceId, idempotencyKey: "ordinary-reservation",
      purpose: "test suite", expectedDurationMs: 60_000, units: 2,
    });
    expect(saturated.outcome).toBe("granted");
    const requested = reservation();
    expect(h.sender.factoryCpuResource(worker.machineId)).toBe(resourceId);
    expect(await h.sender.factoryCpu(requested)).toMatchObject({ state: "ended" });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(worker.instanceId, requested);
    const snapshot = await h.receiver.discover(h.receiver.threadActor("codex", "test-thread"));
    const cpu = snapshot.find(({ resource }) => resource.resourceId === resourceId)?.resource;
    expect(cpu?.allocations).toHaveLength(1);
    expect(cpu?.queue).toHaveLength(0);
  } finally {
    await h.close();
  }
});

it("a peer grant survives an authority restart and competes with ordinary grants through another profile", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const h = rig();
  try {
    const requested = reservation();
    const measured = await measureSqliteWrites(async () => {
      const grant = await h.sender.factoryCpu(requested);
      expect(grant).toMatchObject({ state: "granted", deadlineAt: 1_800_001_800_000 });
      return grant;
    });
    expectSqliteWriteBudget({
      scenario: "factory-cpu-peer-reserve", note: "One scoped peer CPU reservation in the same machine ledger used by ordinary profiles.", writes: measured.writes,
    });
    await h.restart();
    const replay = await measureSqliteWrites(async () => {
      expect(await h.sender.factoryCpu(requested)).toEqual(measured.result);
      expect(await h.sender.factoryCpu({ ...requested, action: "status" })).toEqual(measured.result);
    });
    expect(replay.writes.commits).toBe(0);
    const competing = await h.alias.perform({
      kind: "request", resourceId, idempotencyKey: "another-profile",
      purpose: "test suite", expectedDurationMs: 60_000, units: 2,
    });
    expect(competing.outcome).toBe("queued");
    const request = { ...requested, action: "release" as const };
    expect(await h.sender.factoryCpu(request)).toMatchObject({ state: "ended" });
    const snapshot = await h.alias.discover(h.alias.threadActor("codex", "test-thread"));
    expect(snapshot.find(({ resource }) => resource.resourceId === resourceId)?.resource.allocations)
      .toEqual([expect.objectContaining({ units: 2 })]);
    expect(await h.sender.factoryCpu(requested)).toMatchObject({ state: "ended" });
  } finally {
    await h.close();
    vi.unstubAllEnvs();
  }
});

it("denies relayed, disconnected, unapproved and contained callers and isolates approved gateways", async () => {
  const h = rig();
  try {
    const request = reservation();
    expect(() => h.receive(gateway.instanceId, request, other)).toThrow("direct enrolled peer");
    expect(() => h.receive(unapproved, request)).toThrow("not approved");
    expect(() => h.receive("unregistered-peer", request)).toThrow("full enrolled peer");
    h.enrollments.set(other, { status: "connected", permissionRole: "contained" });
    expect(() => h.receive(other, request)).toThrow("full enrolled peer");
    h.enrollments.set(other, { status: "connected", permissionRole: "full" });
    const granted = await h.sender.factoryCpu(request);
    expect(granted?.state).toBe("granted");
    expect(h.receive(other, { ...request, action: "status" })).toBeNull();
    expect(h.receive(other, { ...request, action: "release" })).toMatchObject({ state: "ended" });
    expect(await h.sender.factoryCpu({ ...request, action: "status" })).toEqual(granted);
    expect(await h.sender.factoryCpu(reservation())).toMatchObject({ state: "ended" });
    h.goOffline();
    await expect(h.sender.factoryCpu({ ...request, action: "status" })).rejects.toThrow("disconnected");
    expect(() => h.receive(gateway.instanceId, request)).toThrow("direct enrolled peer");
  } finally {
    await h.close();
  }
});

it("rejects operator or allocation impersonation on either remote checkout route", async () => {
  const h = rig();
  try {
    const request = reservation();
    const ordinary = await h.receiver.perform({
      kind: "request", resourceId, idempotencyKey: "ordinary",
      purpose: "test suite", expectedDurationMs: 60_000, units: 1,
    });
    expect(ordinary.outcome).toBe("granted");
    if (ordinary.outcome !== "granted") throw new Error("Missing ordinary grant");
    expect(() => h.receive(gateway.instanceId, { ...request, action: "release",
      allocationId: ordinary.allocationId, generation: ordinary.generation, subject: { kind: "operator" },
    })).toThrow("Invalid Factory CPU");
    expect(() => h.receiver.receivePeer(gateway.instanceId, { operation: "perform", resourceId, action: ordinary }))
      .toThrow("no checkout authority");
    expect(() => h.receiver.receivePeer(gateway.instanceId, { operation: "read", resourceId: consentKey }))
      .toThrow("no checkout authority");
    expect(() => h.receive(gateway.instanceId, { ...request, resourceId: `machine:${gateway.machineId}:cpu` }))
      .toThrow("Invalid Factory CPU");
    const grant = await h.sender.factoryCpu(request);
    if (grant?.state !== "granted") throw new Error("Missing Factory grant");
    expect(await h.receiver.perform({
      kind: "release", resourceId, idempotencyKey: "generic-release",
      allocationId: grant.allocationId, generation: grant.generation,
    })).toMatchObject({ outcome: "rejected", reason: "not_authorized" });
    expect(await h.sender.factoryCpu({ ...request, action: "status" })).toEqual(grant);
  } finally {
    await h.close();
  }
});

it("fails closed with only an external store even when gateway consent exists", async () => {
  const { tempDir } = createTempStateDb("factory-no-machine-ledger-");
  const receiver = new DesktopResourceCheckoutService({
    viewer: { ...worker, profile: "worker", instanceLabel: "Worker" },
    externalStore: openFederationCheckoutStorage(tempDir, worker.machineId),
    ...loadBindings(tempDir, [consent()]), warn: () => {}, requestPeer: noPeer,
  });
  try {
    expect(receiver.factoryCpuResource(worker.machineId)).toBeUndefined();
    expect(() => receiver.receiveFactoryCpu(gateway.instanceId, reservation())).toThrow("machine capacity is unavailable");
  } finally {
    await receiver.close();
    removeTempStateDbDir(tempDir);
  }
});

it.each([16, 32, 64])("keeps CPU RPCs constant with %s unrelated bindings", async (count) => {
  const { tempDir } = createTempStateDb("factory-routing-scale-");
  const bindings = [...Array.from({ length: count }, (_, i) =>
    consent(`mach_00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`, `other-${i}`)), consent()];
  const generic = vi.fn(noPeer);
  const rpc = vi.fn(async (_id: string, { resourceId, requestId }: FactoryCpuRequest) => ({ resourceId, requestId, state: "ended" as const }));
  const service = new DesktopResourceCheckoutService({
    viewer: { ...gateway, profile: "test", instanceLabel: "Gateway" }, ...loadBindings(tempDir, bindings), warn: () => {},
    requestPeer: generic, requestFactoryCpu: rpc,
  });
  try {
    const request = reservation();
    for (const n of [1, 2, 4]) {
      rpc.mockClear();
      for (let i = 0; i < n; i++) await service.factoryCpu(request);
      expect(rpc.mock.calls).toEqual(Array.from({ length: n }, () => [worker.instanceId, request]));
      expect(generic).not.toHaveBeenCalled();
    }
  } finally {
    await service.close();
    removeTempStateDbDir(tempDir);
  }
});
