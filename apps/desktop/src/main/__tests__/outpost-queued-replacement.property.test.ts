import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const ref = { backend: "codex", threadId: "native" };
const origin = { kind: "agent", sourceThread: { backend: "codex", threadId: "sender", instanceId: "forged" } };
const envelope = (id: string, sourceInstanceId = "sender-instance") => ({ id, sourceInstanceId });
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise<void>(resolve => setImmediate(resolve)); };
const terminal = (runtime: any, status = "completed") => runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: runtime.store.get(runtime.active).turnId, status } } });

async function fixture(work: (runtime: any, backend: any, store: any, profile: any, events: any[], sent: string[]) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessFederation }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-replace-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  let runtime: any;
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const sent: string[] = [], events: any[] = [];
    runtime.codex = { startTurn: async ({ input }: any) => {
      sent.push(input[0].text);
      return { threadId: ref.threadId, turnId: `turn-${sent.length}` };
    }, stop: async () => {} };
    const federation = new HeadlessFederation({ directory: path.join(root, "headless"), runtime, profile: "fixture", onFailure() {} });
    federation.publish = (event: any) => events.push(event.notification);
    const backend = federation.backend;
    backend.persistCreatedNativeThread({ id: ref.threadId, title: "Existing", titleSource: "explicit", cwd: root });
    runtime.submit({ id: "active", threadId: ref.threadId, prompt: "active" }); await runtime.work;
    await work(runtime, backend, store, profile, events, sent);
  } finally {
    if (runtime) await runtime.stop();
    profile.close(); rmSync(root, { recursive: true, force: true });
  }
}

const queued = async (backend: any, text = "original") => backend.handle("backend.startTurn", { ...ref, input: [{ type: "text", text }], messageOrigin: origin }, envelope("original"));
const replace = (backend: any, queueEntryId: string, text: string, id = "replacement", source = "sender-instance", messageOrigin: any = origin) =>
  backend.handle("backend.replaceQueuedMessage", { ...ref, queueEntryId, input: [{ type: "text", text }], messageOrigin }, envelope(id, source));

it.skipIf(process.platform === "win32")("replacing A before B keeps the new acceptance before its follow-up at the provider", async () => {
  await fixture(async (runtime, backend, store, _profile, events, sent) => {
    const original = await queued(backend, "A"), accepted = store.get(original.queueEntryId);
    runtime.submit({ id: "B", threadId: ref.threadId, prompt: "B" });
    const replacement = await replace(backend, original.queueEntryId, "A edited");
    expect(backend.queuedTurns(ref.threadId).map((entry: any) => entry.queueEntryId)).toEqual([replacement.queueEntryId, "B"]);
    expect(events.findLast(event => event.method === "thread/turnQueue/updated" && event.params.queueEntryId === replacement.queueEntryId)?.params.position).toBe(1);
    expect(store.get(accepted.id)).toMatchObject({ status: "interrupted", fingerprint: accepted.fingerprint });
    expect(replacement.queueEntryId).not.toBe(accepted.id);
    terminal(runtime); await settle();
    expect(sent).toEqual(["active", "A edited"]);
    terminal(runtime); await settle();
    expect(sent).toEqual(["active", "A edited", "B"]);
  });
});

it.skipIf(process.platform === "win32")("generated explicit-new-turn replacements preserve the live FIFO and neighbors across paused and held queues", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }), fc.boolean(),
    fc.array(fc.nat(20), { minLength: 2, maxLength: 6 }), async (pauses, held, replacements) => {
      await fixture(async (runtime, backend, store, _profile, events, sent) => {
        const model: Array<{ id: string; prompt: string; paused: boolean }> = [];
        for (const [index, paused] of pauses.entries()) {
          const prompt = `waiting-${index}`;
          const accepted = await backend.handle("backend.startTurn", { ...ref, delivery: "new_turn", input: [{ type: "text", text: prompt }], messageOrigin: origin }, envelope(prompt));
          model.push({ id: accepted.queueEntryId, prompt, paused });
          if (paused) await runtime.setQueuedTurnPaused({ queueEntryId: accepted.queueEntryId, paused: true });
        }
        if (held) { terminal(runtime, "failed"); await settle(); }
        for (const [step, selected] of replacements.entries()) {
          const index = selected % model.length, original = model[index]!, accepted = store.get(original.id);
          const neighbors = model.filter(entry => entry !== original).map(entry => store.get(entry.id));
          const prompt = `${original.prompt} edited-${step}`;
          const replacement = await replace(backend, original.id, prompt, `fifo-replacement-${step}`);
          model[index] = { ...original, id: replacement.queueEntryId, prompt };
          expect(backend.queuedTurns(ref.threadId).map((entry: any) => ({ id: entry.queueEntryId, paused: Boolean(entry.paused) })))
            .toEqual(model.map(({ id, paused }) => ({ id, paused })));
          expect(events.findLast(event => event.method === "thread/turnQueue/updated" && event.params.queueEntryId === replacement.queueEntryId && event.params.status === "queued")?.params.position).toBe(index + 1);
          expect(store.get(accepted.id)).toMatchObject({ status: "interrupted", fingerprint: accepted.fingerprint });
          expect(neighbors.map(job => store.get(job.id))).toEqual(neighbors);
          expect(sent).toEqual(["active"]);
        }
        for (const entry of model.filter(entry => entry.paused)) await runtime.setQueuedTurnPaused({ queueEntryId: entry.id, paused: false });
        if (held) expect(await runtime.releaseQueuedTurn({ queueEntryId: model[0]!.id })).toMatchObject({ disposition: "started" });
        else { terminal(runtime); await settle(); }
        for (const [index, entry] of model.entries()) {
          expect(sent).toEqual(["active", ...model.slice(0, index + 1).map(entry => entry.prompt)]);
          expect(store.get(entry.id).status).toBe("running");
          terminal(runtime); await settle();
        }
        expect(sent).toEqual(["active", ...model.map(entry => entry.prompt)]);
      });
    }), { numRuns: 12 });
});

it.skipIf(process.platform === "win32")("generated sender replacements cancel immutable acceptance before accepting a new job and never replay old input", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string({ minLength: 1, maxLength: 400 }).filter(text => Boolean(text.trim())), { minLength: 2, maxLength: 6 }), async edits => {
    await fixture(async (runtime, backend, store, _profile, events, sent) => {
      let response = await queued(backend);
      for (const [index, text] of edits.entries()) {
        const accepted = store.get(response.queueEntryId), eventCount = events.length;
        const next = await replace(backend, accepted.id, text, `replacement-${index}`);
        expect(next).toMatchObject({ ...ref, queueStatus: "queued" });
        expect(next.queueEntryId).not.toBe(accepted.id);
        expect(store.get(accepted.id)).toMatchObject({ status: "interrupted", fingerprint: accepted.fingerprint });
        expect(store.get(next.queueEntryId)).toMatchObject({ status: "queued", messageOrigin: { sourceThread: { instanceId: "sender-instance" } } });
        const snapshot = await backend.handle("backend.readQueuedTurn", { ...ref, queueEntryId: next.queueEntryId });
        expect(snapshot.input).toEqual([{ type: "text", text }]);
        expect(events.slice(eventCount).filter(event => event.method === "thread/turnQueue/updated").map(event => [event.params.queueEntryId, event.params.status])).toEqual([[accepted.id, "cancelled"], [next.queueEntryId, "queued"]]);
        const count = store.jobs.size;
        await expect(replace(backend, accepted.id, text, `duplicate-${index}`)).rejects.toThrow();
        expect(store.jobs.size).toBe(count);
        expect(sent).toEqual(["active"]);
        response = next;
      }
      terminal(runtime); await settle();
      expect(sent).toEqual(["active", edits.at(-1)]);
    });
  }), { numRuns: 6 });
});

it.skipIf(process.platform === "win32")("replacement refuses foreign senders, invalid input and unavailable owners before cancelling", async () => {
  await fixture(async (runtime, backend, store, _profile, _events, sent) => {
    const response = await queued(backend), accepted = store.get(response.queueEntryId);
    for (const [source, messageOrigin] of [["other-instance", origin], ["sender-instance", { ...origin, sourceThread: { ...origin.sourceThread, threadId: "other" } }], ["sender-instance", null], ["sender-instance", { kind: "messaging" }]] as const) {
      await expect(replace(backend, accepted.id, "changed", "replacement", source, messageOrigin)).rejects.toThrow();
    }
    for (const text of [" ", "x".repeat(256 * 1024 + 1)]) await expect(replace(backend, accepted.id, text)).rejects.toThrow();
    for (const gate of ["locked", "intake", "creating", "uncertain"]) {
      runtime.threadLocked = () => gate === "locked";
      runtime.intakeBusy = gate === "intake"; backend.creating = gate === "creating"; runtime.uncertain = gate === "uncertain";
      await expect(replace(backend, accepted.id, "changed")).rejects.toThrow();
    }
    runtime.threadLocked = () => false; runtime.intakeBusy = false; backend.creating = false; runtime.uncertain = false;
    expect(store.get(accepted.id)).toEqual(accepted);
    expect(backend.queuedTurns(ref.threadId)).toHaveLength(1);
    expect(sent).toEqual(["active"]);
  });
});

it.skipIf(process.platform === "win32")("cancellation and new-acceptance storage refusals never mutate or replay the old fingerprint", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async refuseCancellation => {
    await fixture(async (runtime, backend, store, _profile, _events, sent) => {
      const response = await queued(backend), original = store.get(response.queueEntryId);
      const save = store.save.bind(store);
      store.save = (job: any) => {
        if (refuseCancellation ? job.id === original.id && job.status === "interrupted" : job.id !== original.id) throw new Error("Storage refused");
        return save(job);
      };
      await expect(replace(backend, original.id, "changed")).rejects.toThrow("Storage refused");
      store.save = save;
      expect(store.get(original.id)).toMatchObject({ fingerprint: original.fingerprint, status: refuseCancellation ? "queued" : "interrupted" });
      expect(backend.queuedTurns(ref.threadId)).toHaveLength(refuseCancellation ? 1 : 0);
      if (!refuseCancellation) await expect(replace(backend, original.id, "changed", "retry")).rejects.toThrow();
      expect(sent).toEqual(["active"]);
      expect(runtime.uncertain).not.toBe(true);
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("serialized replacements, cancellation and pause use the live waiting identity", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("replace", "cancel", "pause", "admit", "stop"), async first => {
    await fixture(async (runtime, backend, store, _profile, _events, sent) => {
      const response = await queued(backend), original = store.get(response.queueEntryId);
      let release!: () => void;
      const lock = runtime.turnQueue.withDispatchSuspended(ref, () => new Promise<void>(resolve => { release = resolve; }));
      await Promise.resolve();
      let earlier: Promise<unknown>;
      if (first === "replace") earlier = replace(backend, original.id, "first", "first");
      else if (first === "cancel") earlier = runtime.cancelQueuedTurn({ queueEntryId: original.id });
      else if (first === "pause") earlier = runtime.setQueuedTurnPaused({ queueEntryId: original.id, paused: true });
      else {
        release(); await lock;
        if (first === "stop") await runtime.stop();
        else { terminal(runtime); await settle(); }
        earlier = Promise.resolve();
      }
      const later = replace(backend, original.id, "later", "later");
      const results = Promise.allSettled([earlier, later]);
      release(); await lock;
      const outcomes = await results;
      expect(outcomes[1].status).toBe(first === "pause" ? "fulfilled" : "rejected");
      if (first === "pause") expect(backend.queuedTurns(ref.threadId)[0]).toMatchObject({ paused: true, pauseRevision: 1 });
      expect(store.get(original.id)).toMatchObject({ fingerprint: original.fingerprint });
      expect(sent).toEqual(first === "admit" ? ["active", "original"] : ["active"]);
      expect(store.jobs.size).toBe(first === "replace" || first === "pause" ? 3 : 2);
    });
  }), { numRuns: 10 });
});

it.skipIf(process.platform === "win32")("replacement preserves the parent's reserved same-FIFO release before cancelling fresh input", async () => {
  await fc.assert(fc.asyncProperty(fc.nat({ max: 2 }), fc.nat({ max: 2 }), async (target, observation) => {
    await fixture(async (runtime, backend, store, _profile, _events, sent) => {
      const waiting: Array<{ queueEntryId: string }> = [];
      for (let n = 0; n < 3; n++) waiting.push(await backend.handle("backend.startTurn", {
        ...ref, delivery: "new_turn", input: [{ type: "text", text: `waiting${n}` }], messageOrigin: origin,
      }, envelope(`waiting${n}`)));
      terminal(runtime, "failed"); await settle();
      const accepted = waiting.map(entry => store.get(entry.queueEntryId));
      const observe = runtime.onEvent;
      let control: Promise<any> | undefined;
      runtime.onEvent = (event: any) => {
        observe(event);
        if (!control && event.method === "headless/queueChanged" && event.params.type === "queued"
          && event.params.entry.id === waiting[observation]!.queueEntryId) {
          control = replace(backend, waiting[target]!.queueEntryId, "changed").then(
            (value: { queueEntryId: string }) => ({ value }), (error: Error) => ({ error }),
          );
        }
      };
      expect(await runtime.releaseQueuedTurn({ queueEntryId: waiting[0]!.queueEntryId }))
        .toMatchObject({ disposition: "started", turnId: "turn-2" });
      expect(control).toBeDefined();
      const result = await control;
      const model = waiting.slice(1).map(entry => entry.queueEntryId);
      if (target === 0) expect(result.error?.message).toContain("not found or already started");
      else {
        expect(result.value.queueEntryId).not.toBe(waiting[target]!.queueEntryId);
        model[target - 1] = result.value.queueEntryId;
        expect(store.get(waiting[target]!.queueEntryId)).toMatchObject({ status: "interrupted", fingerprint: accepted[target].fingerprint });
      }
      expect(backend.queuedTurns(ref.threadId).map((entry: any) => entry.queueEntryId)).toEqual(model);
      expect(store.get(waiting[0]!.queueEntryId)).toMatchObject({ status: "running", fingerprint: accepted[0].fingerprint, turnId: "turn-2" });
      expect(runtime.dispatches.size).toBe(0);
      expect(runtime.queueRelease).toBeNull();
      expect(sent).toEqual(["active", "waiting0"]);
      for (let n = 1; n < 3; n++) { terminal(runtime); await settle(); }
      expect(sent).toEqual(["active", "waiting0", target === 1 ? "changed" : "waiting1", target === 2 ? "changed" : "waiting2"]);
    });
  }), { numRuns: 12, examples: [[0, 0], [1, 0], [2, 2]] });
});

it.skipIf(process.platform === "win32")("shutdown during replacement acceptance preserves both outcomes without restoring prompts or replaying jobs", async () => {
  await fixture(async (runtime, backend, store, profile, _events, sent) => {
    const response = await queued(backend), original = store.get(response.queueEntryId);
    const observe = runtime.onEvent;
    let stopping: Promise<void> | undefined;
    runtime.onEvent = (event: any) => {
      observe(event);
      if (event.method === "headless/jobChanged" && event.params.id !== original.id && event.params.status === "queued") stopping = runtime.stop();
    };
    const replacement = await replace(backend, original.id, "changed");
    await stopping;
    expect(store.get(original.id)).toMatchObject({ status: "interrupted", fingerprint: original.fingerprint });
    expect(store.get(replacement.queueEntryId)).toMatchObject({ status: "unknown" });
    const { JobStore } = await load("store.js");
    const reopened = new JobStore(path.dirname(store.directory), { version: 1, workspace: runtime.workspace, codexHome: path.join(runtime.workspace, "codex") }, profile);
    expect(reopened.get(original.id).fingerprint).toBe(original.fingerprint);
    expect(reopened.get(replacement.queueEntryId).status).toBe("unknown");
    expect(runtime.turnQueue.getAllQueuedEntries()).toEqual([]);
    expect(JSON.stringify([...reopened.jobs.values()])).not.toContain('"prompt"');
    expect(sent).toEqual(["active"]);
  });
});

it.skipIf(process.platform === "win32")("replacement retains current pause and hold controls but has a new acceptance and never interrupts admission", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (paused, held) => {
    await fixture(async (runtime, backend, store, _profile, _events, sent) => {
      const original = await queued(backend);
      if (paused) await runtime.setQueuedTurnPaused({ queueEntryId: original.queueEntryId, paused: true });
      if (held) { terminal(runtime, "failed"); await settle(); }
      const replacement = await replace(backend, original.queueEntryId, "changed");
      const entry = backend.queuedTurns(ref.threadId)[0];
      expect(Boolean(entry.paused)).toBe(paused);
      expect(Boolean(entry.manualReleaseRequired)).toBe(held);
      expect(store.get(original.queueEntryId).status).toBe("interrupted");
      if (runtime.active) terminal(runtime);
      await settle();
      if (paused) await runtime.setQueuedTurnPaused({ queueEntryId: replacement.queueEntryId, paused: false });
      if (held) expect(await runtime.releaseQueuedTurn({ queueEntryId: replacement.queueEntryId })).toMatchObject({ disposition: "started" });
      await settle();
      expect(sent).toEqual(["active", "changed"]);
      await expect(replace(backend, replacement.queueEntryId, "too late", "too-late")).rejects.toThrow();
      expect(sent).toEqual(["active", "changed"]);
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("replacement commits only cancellation and fresh acceptance while rejected and duplicate attempts cost zero writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    await fixture(async (_runtime, backend) => {
      const original = await queued(backend);
      const { writes } = await measureSqliteWrites(async () => {
        await replace(backend, original.queueEntryId, "changed");
      });
      expectSqliteWriteBudget({ budgetFile: "outpost-queued-replacement-write-budgets.json", scenario: "queued-replacement", note: "One actual owner replacement: durable cancellation plus new queued acceptance; initial admission and completion excluded", writes });
      const refused = await measureSqliteWrites(async () => {
        for (let n = 0; n < 100; n++) await expect(replace(backend, original.queueEntryId, "changed", `duplicate-${n}`)).rejects.toThrow();
      });
      expectSqliteWriteBudget({ budgetFile: "outpost-queued-replacement-write-budgets.json", scenario: "replacement-refusals", note: "100 attempts to replace the cancelled acceptance; no replay or new job", writes: refused.writes });
    });
  } finally { vi.unstubAllEnvs(); }
});
