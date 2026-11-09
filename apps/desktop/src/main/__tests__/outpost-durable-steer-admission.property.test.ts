import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { canonicalDurableSteerRequest, type SubmitDurableSteerRequest } from "@pwragent/shared";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

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
    const value = (text = "steer", id = randomUUID(), expectedTurnId = "turn-1"): SubmitDurableSteerRequest => {
      const request: SubmitDurableSteerRequest = { clientRequest: { version: 1, id, createdAt: Date.now(), payloadHash: "" },
        request: { ...ref, expectedTurnId, input: [{ type: "text", text }] } };
      request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableSteerRequest(federation.state.instanceId, request)).digest("hex");
      return request;
    };
    runtime.submit({ id: "active", threadId: ref.threadId, prompt: "active" });
    await runtime.work;
    const terminal = () => runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: "turn-1", status: "completed" } } });
    await work({ runtime, backend, federation, store, profile, steers, starts, events, submit, get, value, terminal, envelope });
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
