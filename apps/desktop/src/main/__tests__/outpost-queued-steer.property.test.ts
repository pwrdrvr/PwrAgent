import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const ref = { backend: "codex" as const, threadId: "native" };
const drain = async () => { for (let i = 0; i < 24; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function fixture(work: (f: any) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessFederation }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-qsteer-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  let runtime: any;
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const steers: any[] = [], starts: any[] = [], events: any[] = [];
    runtime.codex = {
      startTurn: async (request: any) => { starts.push(request); return { threadId: request.threadId, turnId: `turn-${starts.length}` }; },
      steerTurn: async (request: any) => { steers.push(request); return { threadId: request.threadId, turnId: request.expectedTurnId }; },
      stop: async () => {},
    };
    const federation = new HeadlessFederation({ directory: path.join(root, "headless"), runtime, profile: "fixture", onFailure() {} });
    federation.ensureIdentity("fixture");
    federation.publish = (event: any) => events.push(event.notification);
    const backend = federation.backend;
    backend.persistCreatedNativeThread({ id: ref.threadId, title: "Existing", titleSource: "explicit", cwd: root });
    const envelope = { sourceInstanceId: "issuer", targetInstanceId: federation.state.instanceId, id: "transport" };
    const value = (id: string, text = id) => ({ ...ref, queueEntryId: id, input: [{ type: "text", text }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: `sender-${id}`, instanceId: "untrusted-claim" } } });
    const submit = (request: any) => backend.handle("backend.startTurn", request, envelope);
    const terminal = (turnId = "turn-1", status = "completed") => runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: turnId, status } } });
    runtime.submit({ id: "active", threadId: ref.threadId, prompt: "active" });
    await runtime.work;
    await work({ root, runtime, backend, federation, store, profile, steers, starts, events, submit, value, terminal, envelope });
  } finally {
    if (runtime) await runtime.stop();
    profile.close(); rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("each accepted default agent input steers once under its own immutable identity and retains the native owner", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }), async (count, copies) => {
    await fixture(async ({ runtime, backend, store, steers, starts, events, submit, value, terminal }: any) => {
      const accepted: any[] = [];
      for (let i = 0; i < count; i++) {
        const request = value(`message${i}`, `private-${i}`);
        const result = await submit(request);
        accepted.push({ request, id: result.queueEntryId, fingerprint: store.get(result.queueEntryId).fingerprint });
        for (let j = 0; j < copies; j++) expect((await submit(request)).queueEntryId).toBe(result.queueEntryId);
      }
      await drain();
      expect(steers.map((request: any) => request.input[0].text)).toEqual(accepted.map(({ request }) => request.input[0].text));
      expect(steers.every((request: any) => request.expectedTurnId === "turn-1")).toBe(true);
      expect(starts).toHaveLength(1);
      expect(runtime.active).toBe("active");
      expect(backend.activeJob(ref).id).toBe("active");
      expect(runtime.turnQueue.getQueuedEntries(ref)).toEqual([]);
      for (const { request, id, fingerprint } of accepted) {
        expect(store.get(id)).toMatchObject({ fingerprint, status: "running", threadId: ref.threadId, turnId: "turn-1",
          messageOrigin: { sourceThread: { instanceId: "issuer" } } });
        expect(JSON.stringify(store.get(id))).not.toContain("private-");
        await expect(submit({ ...request, input: [{ type: "text", text: "changed" }] })).rejects.toThrow("different input");
        expect(events.some((event: any) => event.method === "thread/turnQueue/updated" && event.params.queueEntryId === id && event.params.status === "started" && event.params.turnId === "turn-1")).toBe(true);
      }
      terminal(); await drain();
      for (const { request, id, fingerprint } of accepted) {
        expect(store.get(id)).toMatchObject({ fingerprint, status: "completed", turnId: "turn-1" });
        expect((await submit(request)).queueEntryId).toBe(id);
      }
      expect(steers).toHaveLength(count);
      expect(starts).toHaveLength(1);
    });
  }), { numRuns: 8 });
});
