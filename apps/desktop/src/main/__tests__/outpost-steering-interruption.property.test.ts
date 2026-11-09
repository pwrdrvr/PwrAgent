import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const actualHost = it.runIf(process.platform === "linux" || process.platform === "darwin");

async function fixture(work: (runtime: any, backend: any, store: any) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-steering-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const backend = new HeadlessBackend(runtime, () => {});
    runtime.onEvent = (event: unknown) => backend.event(event);
    backend.authenticateOrigin = (origin: unknown) => origin;
    runtime.save({ version: 1, id: "job", fingerprint: "accepted", threadId: "native", turnId: "turn", status: "running", createdAt: new Date().toISOString() });
    runtime.active = "job";
    await work(runtime, backend, store);
  } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
}

const request = { backend: "codex", threadId: "native", expectedTurnId: "turn", requestId: "steer", input: [{ type: "text", text: "one input" }] };

actualHost("actual Outpost coalesces accepted steering and retries only refused origin completion", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.boolean(), fc.boolean(), async (copies, refuseOrigin, control) => {
    await fixture(async (runtime, backend, store) => {
      let sends = 0;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const accepted = new Promise<void>(resolve => { release = resolve; });
      const incoming = { kind: "agent", systemReason: "steering-test" };
      const prior = store.get("job");
      runtime.codex = { steerTurn: async () => { sends++; entered(); await accepted; return { threadId: "native", turnId: "turn" }; } };
      const save = store.save.bind(store);
      let refusals = refuseOrigin ? 1 : 0;
      store.save = (job: any) => { if (job.messageOrigin && refusals-- > 0) throw new Error("origin refused"); return save(job); };
      const params = { ...request, messageOrigin: incoming, ...(control ? { operation: "steer" } : {}) };
      const invoke = () => backend.handle(control ? "controlActiveTurn" : "steerTurn", params);
      const pending = Array.from({ length: copies }, invoke);
      // Observe all rejections immediately, including the pre-fix origin write.
      const outcomes = Promise.allSettled(pending);
      if (!refuseOrigin) {
        await started;
        try { expect(store.get("job").messageOrigin).toBeUndefined(); }
        finally { release(); }
      }
      release();
      await outcomes;
      const result = await invoke();
      expect(result).toMatchObject({ backend: "codex", threadId: "native", turnId: "turn", disposition: "steered" });
      expect(sends).toBe(1);
      expect(store.get("job")).toMatchObject({ fingerprint: prior.fingerprint, status: "running", messageOrigin: incoming });
      for (const change of [{ input: [{ type: "text", text: "changed" }] }, { messageOrigin: { ...incoming, systemReason: "changed" } }, { delivery: "now" }]) {
        await expect(backend.handle(control ? "controlActiveTurn" : "steerTurn", { ...params, ...change })).rejects.toThrow();
      }
      expect(sends).toBe(1);
    });
  }), { numRuns: 16 });
});

actualHost("native refusal, unsupported delivery and handoff locks cannot acquire steering origin", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("provider", "lock", "delivery"), async refusal => {
    await fixture(async (runtime, backend, store) => {
      let sends = 0;
      runtime.threadLocked = () => refusal === "lock";
      runtime.codex = { steerTurn: async () => { sends++; throw new Error("native refused"); } };
      const params = { ...request, messageOrigin: { kind: "agent" }, ...(refusal === "delivery" ? { delivery: "now" } : {}) };
      await expect(backend.handle("steerTurn", params)).rejects.toThrow();
      expect(store.get("job").messageOrigin).toBeUndefined();
      expect(sends).toBe(refusal === "provider" ? 1 : 0);
    });
  }), { numRuns: 9 });
});

actualHost("steering completion preserves concurrent provider terminals and interruption retires only on terminal", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("completed", "failed", "interrupted"), fc.boolean(), async (status, rejectInterrupt) => {
    await fixture(async (runtime, backend, store) => {
      let sends = 0;
      runtime.codex = {
        steerTurn: async () => { sends++; return { threadId: "native", turnId: "turn" }; },
        interruptTurn: async () => { if (rejectInterrupt) throw new Error("interrupt refused"); return {}; },
      };
      await backend.handle("steerTurn", request);
      if (rejectInterrupt) await expect(runtime.handle("interrupt", { id: "job" })).rejects.toThrow("interrupt refused");
      else await runtime.handle("interrupt", { id: "job" });
      await backend.handle("steerTurn", request);
      expect(sends).toBe(1);
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const accepted = new Promise<void>(resolve => { release = resolve; });
      runtime.codex.steerTurn = async () => { sends++; entered(); await accepted; return { threadId: "native", turnId: "turn" }; };
      const pending = backend.handle("steerTurn", { ...request, requestId: "terminal", messageOrigin: { kind: "agent" } });
      await started;
      runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status } } });
      release();
      const outcome = await Promise.allSettled([pending]);
      expect(outcome[0].status).toBe("fulfilled");
      expect(store.get("job")).toMatchObject({ status, threadId: "native", turnId: "turn", fingerprint: "accepted" });
      expect(runtime.active).toBeNull();
    });
  }), { numRuns: 12 });
});

actualHost("interrupt refusal restores only its captured active job and never replaces a provider terminal", async () => {
  await fc.assert(fc.asyncProperty(fc.option(fc.constantFrom("completed", "failed", "interrupted"), { nil: undefined }), async terminal => {
    await fixture(async (runtime, _backend, store) => {
      let reject!: (error: Error) => void;
      runtime.codex = { interruptTurn: () => new Promise((_resolve, fail) => { reject = fail; }) };
      const pending = runtime.handle("interrupt", { id: "job" });
      expect(store.get("job").status).toBe("interrupting");
      if (terminal) runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: terminal } } });
      reject(new Error("native refusal"));
      await expect(pending).rejects.toThrow("native refusal");
      expect(store.get("job")).toMatchObject({ status: terminal ?? "running", threadId: "native", turnId: "turn" });
    });
  }), { numRuns: 12 });
});
