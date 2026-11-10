import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);

// These properties construct the executable Runtime, whose private directories
// support Linux/macOS. Shared creation/turn coordinator models remain cross-platform.
async function fixture(work: (runtime: any, backend: any, store: any, root: string) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-lifecycle-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const backend = new HeadlessBackend(runtime, () => {});
    runtime.onEvent = (event: unknown) => backend.event(event);
    await work(runtime, backend, store, root);
    await backend.titles.whenSettled();
  } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
}

it.skipIf(process.platform === "win32")("native creation acceptance survives each independent host failure and keeps the provider identity", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("metadata", "event"), fc.boolean(), async (failure, diagnosticsThrow) => {
    await fixture(async (runtime, backend) => {
      const calls: string[] = [];
      runtime.onFailure = () => { calls.push("diagnostic"); if (diagnosticsThrow) throw new Error("diagnostic refused"); };
      runtime.codex = { startThread: async () => { calls.push("provider"); return { threadId: "native" }; } };
      const persist = backend.persist.bind(backend);
      backend.persist = (thread: unknown) => { calls.push("metadata"); if (failure === "metadata") throw new Error("metadata refused"); persist(thread); };
      backend.invalidate = () => { calls.push("event"); if (failure === "event") throw new Error("event refused"); };
      const result = await backend.startThread({ model: "offered", executionMode: "auto" });
      expect(result).toEqual({ backend: "codex", threadId: "native", executionMode: "auto" });
      expect(runtime.loadedThreads.has("native")).toBe(true);
      expect(backend.owned("native").id).toBe("native");
      expect(calls.filter(call => call !== "diagnostic")).toEqual(["provider", "metadata", "event"]);
      expect(backend.creating).toBe(false);
    });
  }), { numRuns: 12 });
});

it.skipIf(process.platform === "win32")("durable job acceptance and provider outcomes survive generated observer failures and completion orderings without replay", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("acceptance", "thread", "running", "title", "terminal", "none"),
    fc.constantFrom("before-response", "during-finalization", "after-response"), fc.constantFrom("completed", "failed", "interrupted"),
    fc.integer({ min: 0, max: 4 }), async (failure, ordering, terminal, duplicates) => {
      await fixture(async (runtime, backend, store, root) => {
        const calls: string[] = [];
        runtime.onFailure = () => { throw new Error("diagnostics refused"); };
        const observe = runtime.onEvent;
        runtime.onEvent = (event: any) => {
          const phase = event.method === "headless/turnStarted" ? "title"
            : event.params.status === "starting" ? event.params.threadId ? "thread" : "acceptance"
            : event.params.status === "running" ? "running" : "terminal";
          calls.push(phase);
          observe(event);
          if (phase === "title" && ordering === "during-finalization") runtime.notification(completion);
          if (phase === failure) throw new Error(`${phase} observer refused`);
        };
        const completion = { method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: terminal } } };
        runtime.codex = {
          startThread: async (params: any) => {
            calls.push("create");
            expect(params).toMatchObject({ cwd: root, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: false, model: "offered" });
            return { threadId: "native" };
          },
          startTurn: async (params: any) => {
            calls.push("submit");
            expect(store.get("job")).toMatchObject({ threadId: "native", status: "starting" });
            expect(params).toMatchObject({ approvalPolicy: "never", sandbox: "workspace-write", input: [{ type: "text", text: "first prompt" }], reasoningEffort: "high", serviceTier: "fast" });
            if (ordering === "before-response") runtime.notification(completion);
            return { threadId: "native", turnId: "turn" };
          },
        };
        const input = { id: "job", prompt: "first prompt", sandbox: "workspace-write", model: "offered", reasoningEffort: "high", serviceTier: "fast" };
        const accepted = runtime.submit(input);
        expect(accepted.status).toBe("starting");
        await runtime.work;
        if (ordering === "after-response") runtime.notification(completion);
        for (let i = 0; i < duplicates; i++) { runtime.notification(completion); runtime.submit(input); }
        const outcome = store.get("job");
        expect(outcome).toMatchObject({ fingerprint: accepted.fingerprint, threadId: "native", turnId: "turn", status: terminal });
        expect(runtime.submit(input)).toEqual(outcome);
        expect(calls.filter(call => call === "create" || call === "submit")).toEqual(["create", "submit"]);
        expect(calls.indexOf("acceptance")).toBeLessThan(calls.indexOf("create"));
        expect(calls.indexOf("thread")).toBeLessThan(calls.indexOf("submit"));
        expect(calls.indexOf("running")).toBeLessThan(calls.indexOf("title"));
        expect(runtime.active).toBeNull();
        expect(backend.owned("native").id).toBe("native");
        expect(JSON.stringify(outcome)).not.toContain("first prompt");
      });
    },
  ), { numRuns: 30 });
});

it.skipIf(process.platform === "win32")("a refused confirmed-turn write preserves confirmed identity as unknown and never resubmits accepted input", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async early => {
    await fixture(async (runtime, _backend, store) => {
      let submissions = 0;
      runtime.codex = {
        startThread: async () => ({ threadId: "native" }),
        startTurn: async () => {
          submissions++;
          if (early) runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "completed" } } });
          return { threadId: "native", turnId: "turn" };
        },
      };
      const save = store.save.bind(store);
      store.save = (job: any) => { if (job.status === "running") throw new Error("confirmed write refused"); return save(job); };
      const input = { id: "job", prompt: "accepted once" };
      const accepted = runtime.submit(input);
      await runtime.work;
      expect(store.get("job")).toMatchObject({ fingerprint: accepted.fingerprint, threadId: "native", turnId: "turn", status: "unknown" });
      runtime.submit(input);
      expect(submissions).toBe(1);
    });
  }), { numRuns: 8 });
});
