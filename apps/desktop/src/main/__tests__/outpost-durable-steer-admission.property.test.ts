import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { canonicalDurableSteerRequest, canonicalDurableTurnRequest, type SubmitDurableSteerRequest, type SubmitDurableTurnRequest } from "@pwragent/shared";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const ref = { backend: "codex" as const, threadId: "native" };

async function fixture(work: (f: any) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessFederation }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-dsteer-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  let runtime: any;
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const steers: any[] = [], starts: any[] = [], events: any[] = [];
    runtime.codex = {
      startTurn: async (request: any) => { starts.push(request); return { threadId: ref.threadId, turnId: `turn-${starts.length}` }; },
      steerTurn: async (request: any) => { steers.push(request); return { threadId: ref.threadId, turnId: request.expectedTurnId }; },
      stop: async () => {},
    };
    const federation = new HeadlessFederation({ directory: path.join(root, "headless"), runtime, profile: "fixture", onFailure() {} });
    federation.ensureIdentity("fixture");
    federation.publish = (event: any) => events.push(event.notification);
    const backend = federation.backend;
    backend.persistCreatedNativeThread({ id: ref.threadId, title: "Existing", titleSource: "explicit", cwd: root });
    const envelope = { sourceInstanceId: "issuer", targetInstanceId: federation.state.instanceId, id: "transport" };
    const submit = (value: SubmitDurableSteerRequest, callerScope = "device", sourceInstanceId = "issuer") => backend.handle("backend.submitSteerRequest", { ...value, callerScope }, { ...envelope, sourceInstanceId });
    const get = (value: SubmitDurableSteerRequest, callerScope = "device", sourceInstanceId = "issuer") => backend.handle("backend.getSteerRequest", { ...ref, id: value.clientRequest.id, callerScope }, { ...envelope, sourceInstanceId });
    const value = (text = "steer", id: string = randomUUID(), expectedTurnId = "turn-1"): SubmitDurableSteerRequest => {
      const request: SubmitDurableSteerRequest = { clientRequest: { version: 1, id, createdAt: Date.now(), payloadHash: "" },
        request: { ...ref, expectedTurnId, input: [{ type: "text", text }] } };
      request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableSteerRequest(federation.state.instanceId, request)).digest("hex");
      return request;
    };
    runtime.submit({ id: "active", threadId: ref.threadId, prompt: "active" });
    await runtime.work;
    const terminal = () => runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: "turn-1", status: "completed" } } });
    await work({ root, runtime, backend, federation, store, profile, steers, starts, events, submit, get, value, terminal, envelope });
  } finally {
    if (runtime) await runtime.stop();
    profile.close(); rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("generated durable steering retries deliver once to the accepted native turn without changing queued acceptance", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("retry", "read", "changed", "concurrent"), { minLength: 1, maxLength: 12 }), async operations => {
    await fixture(async ({ runtime, store, steers, starts, submit, get, value }: any) => {
      const queued = runtime.submit({ id: "waiting", threadId: ref.threadId, prompt: "waiting" });
      const accepted = store.get("active"), request = value(), receipt = await submit(request);
      expect(receipt).toMatchObject({ ...ref, operation: "steerTurn", state: "dispatched", result: {
        ok: true, requestId: receipt.queueEntryId, turnId: "turn-1", disposition: "steered",
      } });
      for (const operation of operations) {
        if (operation === "changed") await expect(submit(value("changed", request.clientRequest.id))).rejects.toMatchObject({ code: "request_conflict" });
        else if (operation === "read") expect(await get(request)).toEqual(receipt);
        else if (operation === "concurrent") {
          const results = await Promise.all(Array.from({ length: 6 }, () => submit(request)));
          expect(results.every(result => result.queueEntryId === receipt.queueEntryId)).toBe(true);
        } else expect(await submit(request)).toEqual(receipt);
        expect(store.get("active")).toEqual(accepted);
        expect(store.get("waiting")).toEqual(queued);
        expect(runtime.turnQueue.getQueuedEntries(ref).map((entry: any) => entry.id)).toEqual(["waiting"]);
        expect(steers).toHaveLength(1);
        expect(starts).toHaveLength(1);
      }
      expect(steers[0]).toMatchObject({ threadId: ref.threadId, expectedTurnId: "turn-1", input: request.request.input });
    });
  }), { numRuns: 6 });
});

it.skipIf(process.platform === "win32")("concurrent durable claims commit before native steering and use the receipt's exact control identity", async () => {
  await fixture(async ({ backend, runtime, store, steers, submit, get, value }: any) => {
    const request = value(), control = vi.spyOn(backend.steering, "steerTurn");
    const native = runtime.codex.steerTurn;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    runtime.codex.steerTurn = async (params: any) => {
      const scope = JSON.stringify(["steerTurn", JSON.stringify(["federation", "issuer", "device"])]);
      const receipt = store.durableTurnRequests.read(scope, request.clientRequest.id);
      expect(receipt).toMatchObject({ state: "dispatching", payloadHash: request.clientRequest.payloadHash });
      expect(control.mock.calls[0][0]).toMatchObject({ requestId: receipt.queueEntryId, expectedTurnId: "turn-1" });
      await pending;
      return native(params);
    };
    const results = Array.from({ length: 12 }, () => submit(request));
    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    expect(await get(request)).toMatchObject({ state: "dispatching" });
    release();
    const receipts = await Promise.all(results);
    const receipt = await get(request);
    expect(receipts.every(result => result.queueEntryId === receipt.queueEntryId)).toBe(true);
    expect(receipt).toMatchObject({ state: "dispatched", result: { ok: true, requestId: receipt.queueEntryId, turnId: "turn-1" } });
    expect(steers).toHaveLength(1);
  });
});

it.skipIf(process.platform === "win32")("durable issuer/device and operation namespaces cannot read or collide with another accepted request", async () => {
  await fixture(async ({ backend, federation, steers, submit, get, value, envelope }: any) => {
    const request = value(), receipt = await submit(request);
    expect(await get(request, "other-device")).toBeNull();
    expect(await get(request, "device", "other-issuer")).toBeNull();
    const turn: SubmitDurableTurnRequest = { clientRequest: { ...request.clientRequest }, request: { ...ref, input: [{ type: "text", text: "waiting" }] } };
    turn.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(federation.state.instanceId, turn)).digest("hex");
    const queued = await backend.handle("backend.submitTurnRequest", { ...turn, callerScope: "device" }, envelope);
    expect(queued).toMatchObject({ state: "accepted", result: { queueStatus: "queued" } });
    expect(queued.queueEntryId).not.toBe(receipt.queueEntryId);
    expect(await get(request)).toEqual(receipt);
    expect(steers).toHaveLength(1);
  });
});

it.skipIf(process.platform === "win32")("native, live-gate and receipt-finalization refusals retain uncertainty without steering another turn or replaying", async () => {
  for (const phase of ["native", "result", "locked", "stopping", "stale-turn"]) {
    await fixture(async ({ runtime, store, steers, submit, get, value }: any) => {
      const request = value("private input", undefined, phase === "stale-turn" ? "old-turn" : "turn-1");
      if (phase === "native") runtime.codex.steerTurn = async (params: any) => { steers.push(params); throw new Error("private native details"); };
      if (phase === "locked") runtime.threadLocked = () => true;
      if (phase === "stopping") await runtime.stop();
      const write = store.durableTurnRequests.write;
      let refuse = phase === "result";
      store.durableTurnRequests.write = (scope: string, receipt: any) => {
        if (refuse && receipt.result) { refuse = false; throw new Error("private storage details"); }
        return write(scope, receipt);
      };
      try {
        const receipt = await submit(request);
        expect(receipt).toMatchObject({ state: "uncertain", payloadHash: request.clientRequest.payloadHash });
        expect(JSON.stringify(receipt)).not.toContain("private");
        for (let n = 0; n < 12; n++) { expect(await submit(request)).toEqual(receipt); expect(await get(request)).toEqual(receipt); }
        expect(steers).toHaveLength(phase === "result" || phase === "native" ? 1 : 0);
      } finally { store.durableTurnRequests.write = write; }
    });
  }
});

it.skipIf(process.platform === "win32")("refused receipt admission/claim permits only unclaimed work to be attempted", async () => {
  for (const phase of ["accept", "claim"]) {
    await fixture(async ({ store, steers, submit, get, value }: any) => {
      const request = value(), storage = store.durableTurnRequests, insert = storage.insert, write = storage.write;
      let refuse = true;
      storage.insert = (...args: any[]) => { if (refuse && phase === "accept") { refuse = false; throw new Error("refused"); } return insert(...args); };
      storage.write = (scope: string, receipt: any) => {
        if (refuse && phase === "claim" && receipt.state === "dispatching") { refuse = false; throw new Error("refused"); }
        return write(scope, receipt);
      };
      try {
        await expect(submit(request)).rejects.toThrow("refused");
        expect(await get(request)).toEqual(phase === "accept" ? null : expect.objectContaining({ state: "accepted" }));
        expect(steers).toHaveLength(0);
        expect(await submit(request)).toMatchObject({ state: "dispatched" });
        expect(steers).toHaveLength(1);
      } finally { storage.insert = insert; storage.write = write; }
    });
  }
});

it.skipIf(process.platform === "win32")("late native acceptance remains bound to the old turn after a queued turn starts and shutdown retires the host", async () => {
  await fixture(async ({ runtime, store, steers, submit, get, value, terminal }: any) => {
    const request = value(), native = runtime.codex.steerTurn;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    runtime.codex.steerTurn = async (params: any) => { entered(); await pending; return native(params); };
    const result = submit(request);
    await dispatched;
    runtime.submit({ id: "next", threadId: ref.threadId, prompt: "next" });
    terminal();
    await vi.waitFor(() => expect(store.get("next").turnId).toBe("turn-2"));
    const fingerprint = store.get("next").fingerprint;
    await runtime.stop();
    release();
    const receipt = await result;
    expect(receipt).toMatchObject({ state: "dispatched", result: { turnId: "turn-1", disposition: "steered" } });
    expect(store.get("next")).toMatchObject({ status: "unknown", turnId: "turn-2", fingerprint });
    expect(steers.map((request: any) => request.expectedTurnId)).toEqual(["turn-1"]);
    const { HeadlessBackend } = await load("federation-backend.js");
    const reopened = new HeadlessBackend(runtime, () => {}, () => receipt.ownerInstanceId);
    expect(await reopened.handle("backend.submitSteerRequest", { ...request, callerScope: "device" }, { sourceInstanceId: "issuer" })).toEqual(receipt);
    expect(await get(request)).toEqual(receipt);
    expect(steers).toHaveLength(1);
  });
});

it.skipIf(process.platform === "win32")("durable steering rejects unsigned fields and another owner's hash before creating a receipt", async () => {
  await fixture(async ({ federation, steers, submit, get, value }: any) => {
    for (const extra of [{ messageOrigin: { kind: "agent" } }, { delivery: "now" }, { queueEntryId: "forged" }, { requestId: "forged" }, { operation: "stop" }]) {
      const request = value();
      Object.assign(request.request, extra);
      request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableSteerRequest(federation.state.instanceId, request)).digest("hex");
      await expect(submit(request)).rejects.toMatchObject({ code: "request_invalid" });
      expect(await get(request)).toBeNull();
    }
    const other = value();
    other.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableSteerRequest("other-owner", other)).digest("hex");
    await expect(submit(other)).rejects.toMatchObject({ code: "request_hash_mismatch" });
    expect(await get(other)).toBeNull();
    expect(steers).toHaveLength(0);
  });
});

it.skipIf(process.platform === "win32")("a fresh host never reclaims a persisted steering claim after both finalization writes were refused", async () => {
  await fixture(async ({ backend, runtime, store, steers, submit, value }: any) => {
    const request = value(), storage = store.durableTurnRequests, write = storage.write;
    storage.write = (scope: string, receipt: any) => {
      if (receipt.state !== "dispatching") throw new Error("finalization refused");
      return write(scope, receipt);
    };
    try { await expect(submit(request)).rejects.toThrow("finalization refused"); }
    finally { storage.write = write; }
    const { HeadlessBackend } = await load("federation-backend.js");
    const reopened = new HeadlessBackend(runtime, () => {}, () => backend.ownerInstanceId());
    const envelope = { sourceInstanceId: "issuer" }, lookup = { ...ref, id: request.clientRequest.id, callerScope: "device" };
    const claimed = await reopened.handle("backend.getSteerRequest", lookup, envelope);
    expect(claimed).toMatchObject({ state: "dispatching" });
    expect(await reopened.handle("backend.submitSteerRequest", { ...request, callerScope: "device" }, envelope)).toEqual(claimed);
    const clock = vi.spyOn(Date, "now").mockReturnValue(claimed.updatedAt + 5 * 60_000 + 1);
    try {
      const uncertain = await reopened.handle("backend.getSteerRequest", lookup, envelope);
      expect(uncertain).toMatchObject({ state: "uncertain", payloadHash: request.clientRequest.payloadHash, queueEntryId: claimed.queueEntryId });
      expect(await reopened.handle("backend.submitSteerRequest", { ...request, callerScope: "device" }, envelope)).toEqual(uncertain);
      expect(steers).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
});

it.skipIf(process.platform === "win32")("a new Runtime and profile connection retain dispatched and uncertain steering receipts without native replay", async () => {
  for (const uncertain of [false, true]) {
    await fixture(async ({ root, runtime, steers, submit, value, envelope }: any) => {
      if (uncertain) runtime.codex.steerTurn = async (request: any) => { steers.push(request); throw new Error("unconfirmed"); };
      const request = value(), receipt = await submit(request);
      expect(receipt.state).toBe(uncertain ? "uncertain" : "dispatched");
      await runtime.stop();
      const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
      let reopened: any;
      try {
        const [{ JobStore }, { Runtime }, { HeadlessFederation }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation.js")]);
        const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
        reopened = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
        const sends = vi.fn();
        reopened.codex = { steerTurn: sends, startTurn: sends, stop: async () => {} };
        const federation = new HeadlessFederation({ directory: path.join(root, "headless"), runtime: reopened, profile: "fixture", onFailure() {} });
        expect(await federation.backend.handle("backend.submitSteerRequest", { ...request, callerScope: "device" }, envelope)).toEqual(receipt);
        expect(await federation.backend.handle("backend.getSteerRequest", { ...ref, id: request.clientRequest.id, callerScope: "device" }, envelope)).toEqual(receipt);
        expect(reopened.turnQueue.getAllQueuedEntries()).toEqual([]);
        expect(store.get("active").status).toBe("unknown");
        expect(sends).not.toHaveBeenCalled();
        expect(steers).toHaveLength(1);
      } finally { if (reopened) await reopened.stop(); profile.close(); }
    });
  }
});

it.skipIf(process.platform === "win32")("durable steering writes only at receipt boundaries and never on matching or uncertain retries", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    await fixture(async ({ runtime, steers, submit, get, value }: any) => {
      const request = value();
      const accepted = await measureSqliteWrites(() => submit(request));
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-steer-write-budgets.json", scenario: "native-acceptance", note: "Actual steer receipt admission, claim and accepted native result; owner/job setup excluded", writes: accepted.writes });
      const duplicates = await measureSqliteWrites(async () => { for (let n = 0; n < 100; n++) { await submit(request); await get(request); } });
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-steer-write-budgets.json", scenario: "duplicate-read", note: "100 matching accepted steer submissions and receipt reads with no native resend", writes: duplicates.writes });
      runtime.codex.steerTurn = async (params: any) => { steers.push(params); throw new Error("Unconfirmed native outcome"); };
      const unknown = value("unknown");
      const uncertain = await measureSqliteWrites(() => submit(unknown));
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-steer-write-budgets.json", scenario: "uncertain-outcome", note: "Actual steer receipt admission, claim and uncertainty boundary after an unconfirmed native outcome", writes: uncertain.writes });
      const retries = await measureSqliteWrites(async () => { for (let n = 0; n < 100; n++) { await submit(unknown); await get(unknown); } });
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-steer-write-budgets.json", scenario: "uncertain-retry-read", note: "100 uncertain steer retries and receipt reads with no native resend", writes: retries.writes });
      expect(steers).toHaveLength(2);
    });
    await fixture(async ({ backend, runtime, store, submit, value }: any) => {
      const request = value(), storage = store.durableTurnRequests, write = storage.write;
      storage.write = (scope: string, receipt: any) => {
        if (receipt.state !== "dispatching") throw new Error("finalization refused");
        return write(scope, receipt);
      };
      try { await expect(submit(request)).rejects.toThrow("finalization refused"); }
      finally { storage.write = write; }
      const { HeadlessBackend } = await load("federation-backend.js");
      const reopened = new HeadlessBackend(runtime, () => {}, () => backend.ownerInstanceId());
      const envelope = { sourceInstanceId: "issuer" }, lookup = { ...ref, id: request.clientRequest.id, callerScope: "device" };
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
      try {
        const stale = await measureSqliteWrites(() => reopened.handle("backend.getSteerRequest", lookup, envelope));
        expect(stale.result).toMatchObject({ state: "uncertain" });
        expectSqliteWriteBudget({ budgetFile: "outpost-durable-steer-write-budgets.json", scenario: "stale-claim", note: "One fresh-host receipt read settles a stale durable steering claim as uncertain without replay; claim setup excluded", writes: stale.writes });
      } finally { clock.mockRestore(); }
    });
  } finally { vi.unstubAllEnvs(); }
});
