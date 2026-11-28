import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DurableTurnRequestService } from "@pwragent/owner-core/durable-turn-request-service";
import { ResourceCheckoutAuthority } from "@pwragent/owner-core/resource-checkout-authority";
import type { CheckoutActor } from "@pwragent/owner-core/resource-checkout-storage";
import type { FactoryAdmissionResult, FactoryAdmissionRow } from "@pwragent/owner-core/factory-admission";
import { durableFederationCallerScope, DurableTurnRequestError } from "@pwragent/shared/contracts/durable-turn-requests";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import { SqliteFactoryAdmissionStore } from "@pwragent/sqlite-storage/factory-admission-store";
import { createOwnerFactoryAdmission } from "../factory/factory-admission-runtime";
import { handleOutpostCommand } from "../headless/outpost";
import { readCurrentGitHubOrigin } from "../pr-status/git-remote";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { SqliteDurableTurnRequestStore } from "../storage/durable-turn-request-store";
import { createFactoryAdmissionStorage } from "../storage/factory-admission-storage";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import { factoryCli } from "./fixtures/factory-cli";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

vi.mock(import("../storage/factory-admission-storage"), () => ({ createFactoryAdmissionStorage: vi.fn() }));
vi.mock(import("../pr-status/git-remote"), async (load) => ({
  ...await load(), readCurrentGitHubOrigin: vi.fn(),
}));

const owner = { instanceId: "test-gateway", machineId: "mach_00000000-0000-4000-8000-000000000001" };
const peer = { instanceId: "test-builder", machineId: "mach_00000000-0000-4000-8000-000000000002" };
const alias = { instanceId: "test-alias", machineId: peer.machineId };
const projectKey = "directory:/synthetic/project";
const localWorktree = "/synthetic/owner-worktree";
const remoteWorktree = "/synthetic/peer-worktree";
const brief = "Implement the synthetic acceptance criterion and leave the diff for inspection.";
const subject = { projectKey, issueId: "00000000-1234-4123-9876-000000000262" };
const actor: CheckoutActor = { key: "factory-test", holder: { kind: "operator", label: "Pilot operator" }, manage: true };
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  resetDesktopOverlayStoreForTests();
  vi.unstubAllEnvs();
});

async function setup(options: { remote?: typeof peer; queued?: boolean; unverified?: boolean } = {}) {
  const target = options.remote ?? owner;
  const { dbPath, tempDir } = createTempStateDb("factory-admission-");
  let db = StateDb.open(dbPath);
  const checkoutDb = openResourceCheckoutStore(path.join(tempDir, "capacity.db"), "machine-test");
  cleanups.push(() => {
    checkoutDb.close();
    db.close();
    removeTempStateDbDir(tempDir);
  });
  const state = { online: true, held: true, platform: "darwin", virtualMachine: false, stale: false,
    ownerInstanceId: owner.instanceId,
    loseAck: false, failBefore: false, rejectStart: false, busy: false, failRelease: false, failReserveBefore: false, loseReserveAck: false, now: Date.now() };
  vi.spyOn(Date, "now").mockImplementation(() => state.now);
  cleanups.push(() => vi.restoreAllMocks());
  const storage = new SqliteOverlayStore(db);
  await storage.upsertDirectoryLaunchpad({
    directoryKey: projectKey, directoryKind: "directory", directoryLabel: "Synthetic", directoryPath: "/synthetic/project",
    registeredAt: 1, backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1, updatedAt: 1,
  });
  setDesktopOverlayStoreForTests(storage);
  vi.mocked(readCurrentGitHubOrigin).mockResolvedValue({ host: "github.com", owner: "AsterLabs", repo: "Synthetic" });
  const resourceId = `machine:${target.machineId}:cpu`;
  const checkout = new ResourceCheckoutAuthority(checkoutDb, () => state.now, randomUUID);
  checkout.ensure({
    resourceId, canonicalKey: resourceId, displayName: "Test CPU capacity", kindLabel: "CPU",
    scope: "machine", counted: true, capacity: 2, authorityId: resourceId, epoch: 1,
    maxHoldMs: 3_600_000, publication: "published", revision: 1, updatedAt: 1,
  });
  const dispatch = vi.fn<ConstructorParameters<typeof DurableTurnRequestService>[0]["dispatch"]>(async (request) => {
    expect(request.boundedStart?.before).toBeGreaterThan(state.now);
    if (state.busy) throw new DurableTurnRequestError("request_start_refused");
    return {
      backend: "codex", threadId: request.threadId, queueEntryId: request.queueEntryId,
      turnId: options.queued ? request.queueEntryId! : "turn-1", queueStatus: options.queued ? "queued" : "started",
    };
  });
  const stop = vi.fn(async () => {});
  const cancelQueued = vi.fn(async () => {});
  const approve = (instanceId = target.instanceId) => ({
    ...subject, action: "arm", repository: "AsterLabs/Synthetic", owner,
    target: { instanceId, machineId: target.machineId, threadId: "test-thread",
      worktreePath: target === owner ? localWorktree : remoteWorktree },
    platform: "darwin", brief,
  });
  let durable: DurableTurnRequestService;
  const makeDurable = () => new DurableTurnRequestService({
    storage: new SqliteDurableTurnRequestStore(db), ownerInstanceId: target.instanceId, now: () => state.now,
    authorize: async () => { if (state.rejectStart) throw new DurableTurnRequestError("request_destination_unavailable"); },
    isQueued: async () => true,
    dispatch,
  });
  type Runtime = Parameters<typeof createOwnerFactoryAdmission>[0];
  const load = vi.fn(async () => ({ sampledAt: state.stale ? state.now - 31_000 : state.now }));
  const readThread = vi.fn(async () => ({
    threadStatus: "idle",
    factoryBuilderIsolation: options.unverified ? undefined : "local-only-v1",
    thread: {
      id: "test-thread", source: "codex", linkedDirectories: [{
        path: "/synthetic/project", kind: "worktree", repositoryKey: "github.com/asterlabs/synthetic",
        worktreePath: target === owner ? localWorktree : remoteWorktree,
      }],
    },
  }));
  const backend = { getLoadStatus: load, resolveThreadAdmissionState: readThread,
    controlActiveTurn: stop, cancelQueuedTurn: cancelQueued };
  const submit = vi.fn<Runtime["federation"]["submitDurableTurnRequest"]>(async (scope, request) => {
    if (state.failBefore) throw new Error("Disconnected before submission");
    const receipt = await durable.submit(durableFederationCallerScope(owner.instanceId, scope), request);
    if (state.loseAck) throw new Error("Lost reply");
    return receipt;
  });
  const receipt = vi.fn<Runtime["federation"]["getDurableTurnRequest"]>((scope, request) =>
    durable.get(durableFederationCallerScope(owner.instanceId, scope), request));
  const lookupHost = vi.fn((id: string) => id === state.ownerInstanceId
    ? { ...owner, platform: state.platform, virtualMachine: state.virtualMachine }
    : state.online && id === target.instanceId ? { ...target, platform: state.platform, virtualMachine: state.virtualMachine } : undefined);
  const federation = {
    knownLocalInstanceId: () => state.ownerInstanceId, factoryExecutorHost: lookupHost,
    localBackend: () => backend, remoteBackend: () => backend,
    submitDurableTurnRequest: submit, getDurableTurnRequest: receipt,
  } as unknown as Runtime["federation"];
  const perform = vi.fn<Runtime["checkouts"]["factoryCpu"]>(async (request) => {
    if (!state.online || state.failRelease && request.action === "release"
        || state.failReserveBefore && request.action === "reserve") throw new Error("Disconnected before checkout effect");
    const result = checkout.factoryCpu(owner.instanceId, request);
    if (state.loseReserveAck && request.action === "reserve") throw new Error("Lost checkout response");
    return result;
  });
  const checkouts = {
    factoryCpuResource: (id: string) => id === target.machineId ? resourceId : undefined,
    factoryCpu: perform,
  } as unknown as Runtime["checkouts"];
  const make = () => {
    vi.mocked(createFactoryAdmissionStorage).mockReturnValue(new SqliteFactoryAdmissionStore(db));
    durable = makeDurable();
    return createOwnerFactoryAdmission({ federation, checkouts, leaseHeld: () => state.held });
  };
  let factoryAdmission = make();
  const run = (params: Record<string, unknown>) => handleOutpostCommand(
    { factoryAdmission } as Parameters<typeof handleOutpostCommand>[0], "factory-admission", params,
  ) as Promise<FactoryAdmissionResult>;
  return {
    seedPriorRow: (row: FactoryAdmissionRow) => new SqliteFactoryAdmissionStore(db).insert(row),
    dropStoredTracker: (issueId: string) => db.raw.prepare(
      "UPDATE factory_admission SET row_json = json_remove(row_json, '$.workItem') WHERE project_key = ? AND issue_id = ?",
    ).run(projectKey, issueId),
    approve, run, state, load, readThread, lookupHost, submit, receipt, dispatch, perform, checkout, resourceId, stop, cancelQueued,
    command: (action: string) => run({ ...subject, action, ...(action === "dispatch" ? { brief } : {}) }),
    restart() {
      db.close();
      db = StateDb.open(dbPath);
      setDesktopOverlayStoreForTests(new SqliteOverlayStore(db));
      factoryAdmission = make();
    },
    completed(queueEntryId: string) {
      durable.observeQueueEvent({ backend: "codex", threadId: "test-thread", queueEntryId,
        status: "terminal", terminalStatus: "turn/completed" });
    },
  };
}

it("admits the local issue through Outpost once and measures admission, checkout, dispatch and release writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const h = await setup();
  await expect(h.command("dispatch")).rejects.toThrow("disarmed");
  await expect(h.run({ ...h.approve(), owner: peer })).rejects.toThrow("selected local Federation owner");
  await expect(h.run({ ...h.approve(), repository: "AnotherOrg/Synthetic" })).rejects.toThrow("project is unavailable");

  const measured = await measureSqliteWrites(async () => {
    const armed = await h.run(h.approve());
    const sent = await h.command("dispatch");
    expect(sent).toMatchObject({ row: { id: armed.row.id, phase: "dispatching" }, receipt: { state: "dispatched" } });
    h.completed(sent.receipt!.queueEntryId);
    expect(await h.command("reconcile")).toMatchObject({ row: { phase: "terminal", outcome: "completed" } });
  });
  expectSqliteWriteBudget({ scenario: "factory-admission-local", note: "One operator arm, local and machine intent, durable start and completion, and release through real checkout SQLite.", writes: measured.writes });
  const replay = await measureSqliteWrites(async () => {
    expect((await h.run(h.approve())).row.outcome).toBe("completed");
    await expect(h.run({ ...subject, action: "dispatch", brief: "Different brief" }))
      .rejects.toThrow("Factory approval payload changed.");
    for (let i = 0; i < 16; i += 1) await h.command("status");
  });
  expect(replay.writes.commits).toBe(0);
  expect(h.dispatch).toHaveBeenCalledTimes(1);
  expect(h.load).toHaveBeenCalledTimes(1);
  expect(h.readThread).toHaveBeenCalledTimes(1);
  expect(h.checkout.records(h.resourceId)[0]?.grants).toHaveLength(0);
});

it("refuses a durable start when the receiving owner cannot attest restricted builder support", async () => {
  const h = await setup({ remote: peer, unverified: true });
  await h.run(h.approve());
  expect((await h.command("dispatch")).blocker).toBe("executor_unavailable");
  expect(h.submit).not.toHaveBeenCalled();
});

it("binds the board issue UUID and selected origin through dispatch and rejects a replacement origin", async () => {
  const h = await setup();
  await expect(h.run({ ...h.approve(), issueId: "PWR-262" })).rejects.toThrow();
  const approval = await h.run(h.approve());
  expect(approval.row.issueId).toBe(subject.issueId);
  vi.mocked(readCurrentGitHubOrigin).mockResolvedValue({ host: "github.com", owner: "DifferentTeam", repo: "Synthetic" });
  expect((await h.command("dispatch")).blocker).toBe("project_unavailable");
  expect(h.perform).not.toHaveBeenCalled();
  vi.mocked(readCurrentGitHubOrigin).mockImplementation(async (cwd) => ({
    host: "github.com", owner: cwd === localWorktree ? "DifferentTeam" : "AsterLabs", repo: "Synthetic",
  }));
  expect((await h.command("dispatch")).blocker).toBe("executor_unavailable");
  expect(h.perform).not.toHaveBeenCalled();
  vi.mocked(readCurrentGitHubOrigin).mockResolvedValue({ host: "github.com", owner: "AsterLabs", repo: "Synthetic" });
  await h.command("dispatch");
  const request = h.submit.mock.calls[0]![1].request;
  expect(request.boundedStart).toMatchObject({ repository: "asterlabs/synthetic" });
  expect(request.input[0]).toMatchObject({ text: expect.stringContaining("asterlabs/synthetic") });
});

it("keeps prior issue-key approvals recoverable without starting new work on the old authority", async () => {
  const h = await setup();
  const approval = h.approve();
  expect(h.seedPriorRow({
    projectKey, issueId: "PWR-262", repository: "synthetic", owner, target: approval.target, platform: "darwin",
    requiresE2eVm: false, id: randomUUID(), createdAt: h.state.now, phase: "armed", revision: 1, payloadHash: "a".repeat(64),
  })).toBe(true);
  h.restart();
  const prior = { projectKey, issueId: "pwr-262" };
  expect((await h.run({ ...prior, action: "status" })).row.phase).toBe("armed");
  await expect(h.run({ ...prior, action: "status", issueId: `PWR-${"1".repeat(80)}` })).rejects.toThrow("stable identifier");
  expect((await h.run({ ...prior, action: "reconcile" })).row.phase).toBe("armed");
  await expect(h.run({ ...prior, action: "dispatch", brief })).rejects.toThrow();
  expect((await h.run({ ...prior, action: "cancel" })).row.outcome).toBe("cancelled");
  expect(h.submit).not.toHaveBeenCalled();
  expect((await h.run(approval)).row.phase).toBe("armed");
});

it("keeps old Linear UUID storage and dispatch receipts accessible through both CLI input forms", async () => {
  const h = await setup();
  const run = await factoryCli(h.run);
  const { row: armed } = await run(h.approve());
  expect(h.dropStoredTracker(subject.issueId).changes).toBe(1);
  h.restart();
  const workItem = { provider: "linear", id: subject.issueId.toUpperCase() };
  const { issueId: _issueId, ...approval } = h.approve();
  expect((await run({ ...approval, workItem })).row).toMatchObject({
    id: armed.id, revision: armed.revision, issueId: subject.issueId, workItem: { id: subject.issueId },
  });
  const sent = await run({ projectKey, action: "dispatch", brief, workItem });
  const retry = await run({ ...subject, issueId: ` ${subject.issueId} `, action: "dispatch", brief });
  expect(retry.receipt).toEqual(sent.receipt);
  expect(h.dispatch).toHaveBeenCalledTimes(1);
  expect(h.submit.mock.calls[0]![1].request.input[0]).toMatchObject({
    text: expect.stringContaining(`Factory outcome ${subject.issueId} for asterlabs/synthetic.\n`),
  });
  h.completed(sent.receipt!.queueEntryId);
  expect((await run({ projectKey, action: "reconcile", workItem })).row).toMatchObject({ id: armed.id, outcome: "completed" });
});

it("deduplicates each CLI tracking subject while isolating GitHub repository and kind and Jira site", async () => {
  const h = await setup();
  const run = await factoryCli(h.run);
  const { issueId: _issueId, ...approval } = h.approve();
  const items = [
    { provider: "github", kind: "issue", repositoryId: "R_one", number: 42 },
    { provider: "github", kind: "pull_request", repositoryId: "R_one", number: 42 },
    { provider: "github", kind: "issue", repositoryId: "R_two", number: 42 },
    { provider: "jira", siteId: "one", id: "42" },
    { provider: "jira", siteId: "two", id: "42" },
  ];
  const ids = new Set<string>();
  for (const [index, workItem] of items.entries()) {
    const key = { projectKey, workItem };
    await expect(run({ ...key, action: "status" })).rejects.toThrow("disarmed");
    const arm = { ...approval, workItem };
    const { row } = await run(arm);
    expect(row).toMatchObject({ workItem, phase: "armed" });
    expect(row.issueId).toBeUndefined();
    expect(ids.has(row.id)).toBe(false);
    ids.add(row.id);
    expect((await run(arm)).row.id).toBe(row.id);
    if (index === 0) {
      await expect(run({ ...arm, issueId: subject.issueId })).rejects.toThrow();
      await expect(run({ ...approval, workItem: items[1] })).rejects.toThrow("active outcome");
      const dispatch = { ...key, action: "dispatch", brief };
      const started = await run(dispatch);
      expect(started).toMatchObject({ row: { id: row.id }, receipt: { state: "dispatched", turnId: "turn-1" } });
      expect(h.submit.mock.calls[0]?.[1].clientRequest.id).toBe(row.id);
      expect((await run(dispatch)).receipt).toEqual(started.receipt);
      h.completed(started.receipt!.queueEntryId);
      expect((await run({ ...key, action: "reconcile" })).row).toMatchObject({ id: row.id, outcome: "completed" });
      continue;
    }
    expect((await run({ ...key, action: "cancel" })).row).toMatchObject({ id: row.id, outcome: "cancelled" });
  }
  expect(h.submit).toHaveBeenCalledTimes(1);
});

it("refuses to dispatch or control an approval after another owner opens the same rows", async () => {
  const h = await setup({ remote: peer });
  await h.run(h.approve());
  h.state.ownerInstanceId = "replacement-gateway";
  h.restart();
  for (const action of ["status", "dispatch", "cancel", "reconcile"]) {
    await expect(h.command(action)).rejects.toThrow(/owner/i);
  }
  expect(h.perform).not.toHaveBeenCalled();
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.stop).not.toHaveBeenCalled();
});

it("reconciles a peer's lost durable reply after reopening the owner and does not duplicate against a sibling profile", async () => {
  const h = await setup({ remote: peer });
  const armed = await h.run(h.approve());
  await expect(h.run({ ...h.approve(alias.instanceId), issueId: "00000000-1234-4123-9876-000000000263" })).rejects.toThrow("active outcome");
  await expect(h.run({ ...h.approve(), brief: "a different outcome" })).rejects.toThrow("different Factory approval");
  h.state.loseAck = true;
  expect(await h.command("dispatch")).toMatchObject({ blocker: "dispatch_uncertain" });
  h.restart();
  const replay = await h.command("dispatch");
  expect(replay).toMatchObject({ row: { id: armed.row.id, resourceId: `machine:${peer.machineId}:cpu` }, receipt: { state: "dispatched" } });
  expect(h.submit).toHaveBeenCalledExactlyOnceWith("factory-admission-v1", expect.anything(), { scope: "remote", instanceId: peer.instanceId });
  expect(h.perform.mock.calls.map(([request]) => request.action)).toEqual(["reserve", "status"]);
  expect(h.dispatch).toHaveBeenCalledTimes(1);
  h.completed(replay.receipt!.queueEntryId);
  expect((await h.command("reconcile")).row.outcome).toBe("completed");
});

it("uses the same key after proved absence while the original lease is current", async () => {
  const h = await setup({ remote: peer });
  await h.run(h.approve());
  h.state.failBefore = true;
  expect((await h.command("dispatch")).blocker).toBe("dispatch_uncertain");
  h.restart();
  h.state.failBefore = false;
  expect((await h.command("dispatch")).receipt?.state).toBe("dispatched");
  expect(h.submit.mock.calls[0]?.[1]).toEqual(h.submit.mock.calls[1]?.[1]);
  expect(h.perform.mock.calls.map(([request]) => request.action)).toEqual(["reserve", "status", "status"]);
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});

it("keeps the worktree fence after the CPU lease ends while dispatch is unproved", async () => {
  const h = await setup({ remote: peer });
  await h.run(h.approve());
  h.state.failBefore = true;
  await h.command("dispatch");
  h.state.now += 31 * 60_000;
  h.state.failBefore = false;
  expect((await h.command("dispatch")).blocker).toBe("dispatch_uncertain");
  expect((await h.command("cancel")).blocker).toBe("dispatch_uncertain");
  await expect(h.run({ ...h.approve(), issueId: "00000000-1234-4123-9876-000000000263" })).rejects.toThrow("active outcome");
  expect(h.submit).toHaveBeenCalledTimes(1);
  expect(h.stop).not.toHaveBeenCalled();
  expect(h.checkout.records(h.resourceId)[0]?.grants).toHaveLength(0);
});

it("releases a verified grant on a receiver refusal before durable acceptance", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const h = await setup({ remote: peer });
  await h.run(h.approve());
  h.state.rejectStart = true;
  const { writes, result } = await measureSqliteWrites(() => h.command("dispatch"));
  expect(result).toMatchObject({ row: { outcome: "rejected", phase: "terminal" } });
  expectSqliteWriteBudget({
    scenario: "factory-admission-rejected", note: "Release the CPU grant and settle the fence after a durable pre-acceptance refusal.", writes,
  });
  expect(h.perform.mock.calls.map(([request]) => request.action)).toEqual(["reserve", "release"]);
  expect(h.dispatch).not.toHaveBeenCalled();
  await expect(h.run({ ...h.approve(), issueId: "00000000-1234-4123-9876-000000000263" })).resolves.toMatchObject({ row: { phase: "armed" } });
});

it("scopes pause and running cancellation to the approved issue and durable turn ID", async () => {
  const h = await setup();
  await h.run(h.approve());
  await h.command("pause");
  expect((await h.command("dispatch")).blocker).toBe("paused");
  expect(h.load).not.toHaveBeenCalled();
  await expect(h.run({ ...subject, issueId: "00000000-1234-4123-9876-000000000263", action: "cancel" })).rejects.toThrow("disarmed");
  await h.command("resume");
  const sent = await h.command("dispatch");
  const cancelled = await h.command("cancel");
  expect(cancelled).toMatchObject({ row: { cancelRequested: true, phase: "dispatching" } });
  expect(h.stop).toHaveBeenCalledExactlyOnceWith({
    operation: "stop", backend: "codex", threadId: "test-thread", expectedTurnId: "turn-1",
    requestId: `factory-cancel:${sent.row.id}`,
  });
  expect(h.checkout.records(h.resourceId)[0]?.grants).toHaveLength(1);
});

it("cancels a queued receipt by queue ID without interrupting another turn", async () => {
  const h = await setup({ queued: true });
  await h.run(h.approve());
  const sent = await h.command("dispatch");
  expect(sent.receipt?.state).toBe("accepted");
  await h.command("cancel");
  expect(h.cancelQueued).toHaveBeenCalledExactlyOnceWith({ queueEntryId: sent.receipt!.queueEntryId });
  expect(h.stop).not.toHaveBeenCalled();
});

it("refuses stale, offline, wrong-OS or VM placement before asking for capacity", async () => {
  const h = await setup({ remote: peer });
  await h.run(h.approve());
  for (const patch of [{ online: false }, { stale: true }, { platform: "win32" }, { virtualMachine: true }]) {
    const original = { ...h.state };
    Object.assign(h.state, patch);
    expect((await h.command("dispatch")).blocker).toBe("executor_unavailable");
    Object.assign(h.state, original);
  }
  expect(h.perform).not.toHaveBeenCalled();
  expect(h.dispatch).not.toHaveBeenCalled();
  await h.command("cancel");
  const vmSubject = { ...subject, issueId: "00000000-1234-4123-9876-000000000263" };
  await h.run({ ...h.approve(), ...vmSubject, requiresE2eVm: true });
  expect((await h.run({ ...vmSubject, action: "dispatch", brief })).blocker).toBe("e2e_vm_unsupported");
  expect(h.load).toHaveBeenCalledTimes(1);
});

it("requires the active Federation owner lease on every control request", async () => {
  const h = await setup();
  await h.run(h.approve());
  h.state.held = false;
  await expect(h.command("dispatch")).rejects.toThrow("selected local Federation owner");
  await expect(h.command("cancel")).rejects.toThrow("selected local Federation owner");
  expect(h.perform).not.toHaveBeenCalled();
});

it("settles a receiver busy race and releases capacity when its reply is lost", async () => {
  const h = await setup({ remote: peer });
  await h.run(h.approve());
  h.state.busy = true;
  h.state.loseAck = true;
  expect((await h.command("dispatch")).blocker).toBe("dispatch_uncertain");
  h.restart();
  expect(await h.command("reconcile")).toMatchObject({
    row: { phase: "terminal", outcome: "failed" }, receipt: { state: "completed", outcome: "failed" },
  });
  expect(h.submit).toHaveBeenCalledTimes(1);
  expect(h.perform.mock.calls.map(([request]) => request.action)).toEqual(["reserve", "release"]);
});

it("refuses a peer dispatch without queueing when the worker's ordinary CPU pool is saturated", async () => {
  const h = await setup({ remote: peer });
  expect(h.checkout.perform({ ...actor, key: "another-operator" }, {
    kind: "request", resourceId: h.resourceId, units: 2, expectedDurationMs: 60_000,
    purpose: "Other work", idempotencyKey: "hold-both",
  }).outcome).toBe("granted");
  await h.run(h.approve());
  expect(await h.command("dispatch")).toMatchObject({
    row: { phase: "terminal", outcome: "rejected" }, blocker: "capacity_unavailable",
  });
  expect(h.perform.mock.calls.map(([request]) => request.action)).toEqual(["reserve"]);
  expect(h.checkout.records(h.resourceId)[0]?.queue).toEqual([]);
  expect(h.checkout.records(h.resourceId)[0]?.grants).toHaveLength(1);
  expect(h.dispatch).not.toHaveBeenCalled();
});

it("bounds writes for pause, resume and cancel before dispatch", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const h = await setup();
  await h.run(h.approve());
  const { writes } = await measureSqliteWrites(async () => {
    for (const action of ["pause", "pause", "resume", "resume", "cancel", "cancel"]) await h.command(action);
  });
  expectSqliteWriteBudget({
    scenario: "factory-admission-controls", note: "Each changed pause or resume writes once. Cancel intent and settlement write once each. Replays write nothing.", writes,
  });
  expect(h.perform).not.toHaveBeenCalled();
  expect(h.submit).not.toHaveBeenCalled();
});

it("recovers a failed checkout release and keeps terminal proof across a restart", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const h = await setup();
  await h.run(h.approve());
  const dispatched = await h.command("dispatch");
  h.completed(dispatched.receipt!.queueEntryId);
  h.state.failRelease = true;
  expect(await h.command("reconcile")).toMatchObject({
    row: { phase: "closing", outcome: "completed" }, blocker: "checkout_uncertain",
  });
  h.restart();
  h.state.failRelease = false;
  const { writes, result } = await measureSqliteWrites(() => h.command("reconcile"));
  expect(result.row).toMatchObject({ phase: "terminal", outcome: "completed", queueEntryId: dispatched.receipt!.queueEntryId });
  expectSqliteWriteBudget({
    scenario: "factory-admission-release-recovery", note: "Retry the original checkout release, then settle from the retained terminal proof.", writes,
  });
  expect(h.submit).toHaveBeenCalledTimes(1);
  const releases = h.perform.mock.calls.map(([action]) => action).filter(({ action }) => action === "release");
  expect(releases).toHaveLength(2);
  expect(releases[0]).toEqual(releases[1]);
});

it("seals a checkout whose owner crashed in leasing before the first effect", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const h = await setup({ remote: peer });
  const { row } = await h.run(h.approve());
  h.state.failReserveBefore = true;
  expect(await h.command("dispatch")).toMatchObject({ row: { phase: "leasing" }, blocker: "checkout_uncertain" });
  expect(h.submit).not.toHaveBeenCalled();
  h.restart();
  const { writes, result } = await measureSqliteWrites(() => h.command("cancel"));
  expect(result.row).toMatchObject({ phase: "terminal", outcome: "cancelled" });
  expectSqliteWriteBudget({
    scenario: "factory-cpu-seal-before-effect", note: "Cancel intent, closing proof, machine receipt sealing the absent key, and terminal settlement.", writes,
  });
  h.state.failReserveBefore = false;
  expect(await h.perform({ action: "reserve", resourceId: h.resourceId, requestId: row.id }))
    .toMatchObject({ state: "ended" });
  expect(h.checkout.records(h.resourceId)[0]?.grants).toHaveLength(0);
  expect(h.submit).not.toHaveBeenCalled();
});

it("stays disarmed when the grant reply is lost and reuses the original reservation after restart", async () => {
  const h = await setup({ remote: peer });
  const { row } = await h.run(h.approve());
  h.state.loseReserveAck = true;
  expect(await h.command("dispatch")).toMatchObject({ row: { phase: "leasing" }, blocker: "checkout_uncertain" });
  expect(h.submit).not.toHaveBeenCalled();
  const [grant] = h.checkout.records(h.resourceId)[0]!.grants;
  h.restart();
  h.state.loseReserveAck = false;
  expect(await h.command("dispatch")).toMatchObject({
    capacity: { requestId: row.id, state: "granted", allocationId: grant!.id, generation: grant!.generation },
    receipt: { state: "dispatched" },
  });
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});

it("reports ended CPU capacity while a long turn still holds its Factory fence", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const h = await setup({ remote: peer });
  await h.run(h.approve());
  const sent = await h.command("dispatch");
  expect(sent.capacity?.state).toBe("granted");
  h.state.now += 31 * 60_000;
  h.restart();
  const { writes, result } = await measureSqliteWrites(() => h.command("reconcile"));
  expect(result).toMatchObject({
    row: { phase: "dispatching" }, receipt: { turnId: "turn-1" }, capacity: { state: "ended" },
  });
  expectSqliteWriteBudget({
    scenario: "factory-cpu-expiry", note: "Observe the expired CPU grant and keep the unresolved turn fence without a write to the Factory row.", writes,
  });
  expect(h.stop).not.toHaveBeenCalled();
  expect(h.checkout.records(h.resourceId)[0]?.grants).toHaveLength(0);
  await expect(h.run({ ...h.approve(), issueId: "00000000-1234-4123-9876-000000000263" })).rejects.toThrow("active outcome");
  await h.command("cancel");
  expect(h.stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedTurnId: "turn-1" }));
  h.completed(sent.receipt!.queueEntryId);
  expect((await h.command("reconcile")).row.phase).toBe("terminal");
});

it("reports unknown capacity without stopping a matched turn when the authority disconnects", async () => {
  const h = await setup({ remote: peer });
  await h.run(h.approve());
  await h.command("dispatch");
  // Lose only the capacity transport. The turn receipt can still be read.
  h.perform.mockRejectedValueOnce(new Error("CPU authority disconnected"));
  expect(await h.command("reconcile")).toMatchObject({
    row: { phase: "dispatching" }, receipt: { turnId: "turn-1" }, capacity: { state: "unverified" },
  });
  expect(h.stop).not.toHaveBeenCalled();
});

it("does not dispatch from a mismatched or expired capacity reply", async () => {
  const h = await setup({ remote: peer });
  const { row } = await h.run(h.approve());
  const proof = { state: "granted" as const, resourceId: h.resourceId, requestId: row.id,
    allocationId: "capacity-proof", generation: 1, deadlineAt: h.state.now + 30 * 60_000 };
  h.perform.mockResolvedValueOnce({ ...proof, requestId: randomUUID() })
    .mockResolvedValueOnce({ ...proof, deadlineAt: h.state.now - 1 })
    .mockResolvedValueOnce({ ...proof, deadlineAt: h.state.now + 100 });
  for (let i = 0; i < 3; i++) {
    expect((await h.command("dispatch")).blocker).toBe("checkout_uncertain");
  }
  expect(h.submit).not.toHaveBeenCalled();
});
