import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent", file)).href);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

// The executable Runtime's private-directory contract supports Linux/macOS.
async function fixture(work: (runtime: any, backend: any, store: any, profile: any, events: any[]) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("src/store.js"), load("src/runtime.js"), load("src/federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-queue-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  let runtime: any;
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const events: any[] = [];
    const backend = new HeadlessBackend(runtime, (event: any) => events.push(event.notification));
    runtime.onEvent = (event: unknown) => backend.event(event);
    backend.persistCreatedNativeThread({ id: "native", title: "Existing", titleSource: "explicit", cwd: root });
    await work(runtime, backend, store, profile, events);
  } finally {
    if (runtime) { runtime.codex.stop = async () => {}; await runtime.stop(); }
    profile.close(); rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("actual Outpost durable admissions follow the shared FIFO and provider terminals without replay", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 3 }), async (waiting, duplicates) => {
    await fixture(async (runtime, backend, store, _profile, events) => {
      const sent: string[] = [];
      runtime.codex = { startTurn: async (params: any) => {
        const prompt = params.input[0].text;
        expect(store.get(prompt).status).toBe("starting");
        sent.push(prompt);
        return { threadId: "native", turnId: `turn-${prompt}` };
      }, stop: async () => {} };
      const input = (i: number) => ({ id: `job${i}`, threadId: "native", prompt: `job${i}` });
      const accepted = runtime.submit(input(0));
      await runtime.work;
      const fingerprints = [accepted.fingerprint];
      for (let i = 1; i <= waiting; i++) {
        const queued = runtime.submit(input(i));
        expect(queued.status).toBe("queued");
        fingerprints.push(queued.fingerprint);
        for (let repeat = 0; repeat < duplicates; repeat++) expect(runtime.submit(input(i))).toEqual(store.get(`job${i}`));
      }
      const projection = await backend.handle("getNavigationQueueProjection", { protocol: 2, ref: { backend: "codex", threadId: "native" } });
      expect(projection.entries.map((entry: any) => entry.queueEntryId)).toEqual(Array.from({ length: waiting }, (_, i) => `job${i + 1}`));
      expect(sent).toEqual(["job0"]);
      for (let i = 0; i <= waiting; i++) {
        expect(runtime.active).toBe(`job${i}`);
        const terminal = { method: "turn/completed", params: { threadId: "native", turn: { id: `turn-job${i}`, status: "completed" } } };
        runtime.notification(terminal);
        for (let repeat = 0; repeat < duplicates; repeat++) runtime.notification(terminal);
        for (let n = 0; n < 12; n++) await tick();
        expect(store.get(`job${i}`)).toMatchObject({ fingerprint: fingerprints[i], status: "completed", threadId: "native", turnId: `turn-job${i}` });
        expect(JSON.stringify(store.get(`job${i}`))).not.toContain('"prompt"');
      }
      expect(sent).toEqual(Array.from({ length: waiting + 1 }, (_, i) => `job${i}`));
      expect(events.some(event => event.method === "thread/turnQueue/updated" && event.params.status === "queued")).toBe(true);
      expect(runtime.active).toBeNull();
      const { ThreadTurnQueue } = await load("dist/federation-core.js");
      expect(Object.getPrototypeOf(runtime.turnQueue)).toBe(ThreadTurnQueue.prototype);
    });
  }), { numRuns: 12 });
});
