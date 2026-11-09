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
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise<void>(resolve => setImmediate(resolve)); };
const ref = { backend: "codex", threadId: "native" };
const terminal = (runtime: any, turnId: string, status = "completed") => runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: turnId, status } } });

// Real executable construction and real profile storage; only provider effects
// are supplied by the fixture. The executable supports Linux and macOS.
async function fixture(work: (runtime: any, backend: any, store: any, profile: any, events: any[], sent: string[]) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-order-")));
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
    const backend = new HeadlessBackend(runtime, (event: any) => events.push(event.notification));
    runtime.onEvent = (event: unknown) => backend.event(event);
    backend.persistCreatedNativeThread({ id: ref.threadId, title: "Existing", titleSource: "explicit", cwd: root });
    runtime.submit({ id: "active", threadId: ref.threadId, prompt: "active" }); await runtime.work;
    await work(runtime, backend, store, profile, events, sent);
  } finally {
    if (runtime) await runtime.stop();
    profile.close(); rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("actual owner pause and ordering obey an independent waiting-list model without changing acceptance", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ kind: fc.constantFrom("pause", "resume", "move"), from: fc.nat(3), to: fc.nat(5) }), { minLength: 1, maxLength: 18 }), async commands => {
    await fixture(async (runtime, backend, store, _profile, events, sent) => {
      const model = Array.from({ length: 4 }, (_, n) => ({ id: `waiting${n}`, paused: false, revision: 0 }));
      const accepted = model.map(entry => runtime.submit({ id: entry.id, threadId: ref.threadId, prompt: entry.id }));
      for (const command of commands) {
        const entry = model.find(entry => entry.id === `waiting${command.from}`)!;
        const before = backend.queueProjection({ protocol: 2, ref });
        const eventCount = events.length;
        if (command.kind === "move") {
          const anchor = command.to < 4 ? `waiting${command.to}` : command.to === 4 ? undefined : "absent";
          const from = model.indexOf(entry);
          const to = anchor === undefined ? model.length : model.findIndex(entry => entry.id === anchor);
          let disposition = "anchor_not_found";
          if (to >= 0) {
            const destination = to > from ? to - 1 : to;
            disposition = destination === from ? "unchanged" : "moved";
            if (disposition === "moved") { model.splice(from, 1); model.splice(destination, 0, entry); }
          }
          expect(await backend.handle("backend.moveQueuedTurn", { queueEntryId: entry.id, beforeQueueEntryId: anchor })).toEqual({ queueEntryId: entry.id, disposition, queueEntryIds: model.map(entry => entry.id) });
          if (disposition === "moved") expect(events.slice(eventCount)).toContainEqual({ method: "thread/turnQueue/reordered", params: { threadId: ref.threadId, queueEntryIds: model.map(entry => entry.id) } });
        } else {
          const paused = command.kind === "pause", changed = entry.paused !== paused;
          if (changed) { entry.paused = paused; entry.revision++; }
          expect(await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: entry.id, paused, messageOrigin: { kind: "agent", sourceInstanceId: "forged" } })).toEqual({ queueEntryId: entry.id, disposition: changed ? "updated" : "unchanged", paused, ...(entry.revision ? { pauseRevision: entry.revision } : {}) });
          if (changed) expect(events.slice(eventCount)).toContainEqual(expect.objectContaining({ method: "thread/turnQueue/updated", params: expect.objectContaining({ queueEntryId: entry.id, paused, pauseRevision: entry.revision }) }));
        }
        const projection = backend.queueProjection({ protocol: 2, ref });
        expect(projection.entries.map((item: any) => ({ id: item.queueEntryId, paused: Boolean(item.paused), revision: item.pauseRevision ?? 0 }))).toEqual(model);
        expect(projection.entries.map((item: any) => item.position)).toEqual([0, 1, 2, 3]);
        expect(projection.revision === before.revision).toBe(events.length === eventCount);
        expect(accepted.map(job => store.get(job.id))).toEqual(accepted);
        expect(sent).toEqual(["active"]);
      }
      for (const entry of model.filter(entry => !entry.paused)) {
        terminal(runtime, `turn-${sent.length}`); await settle();
        expect(sent.at(-1)).toBe(entry.id);
      }
      terminal(runtime, `turn-${sent.length}`); await settle();
      for (const entry of model.filter(entry => entry.paused)) {
        expect(await runtime.handle("resume", { id: entry.id })).toMatchObject({ disposition: "updated", paused: false, pauseRevision: entry.revision + 1 });
        await settle(); expect(sent.at(-1)).toBe(entry.id);
        terminal(runtime, `turn-${sent.length}`); await settle();
      }
      expect(sent).toEqual(["active", ...model.filter(entry => !entry.paused).map(entry => entry.id), ...model.filter(entry => entry.paused).map(entry => entry.id)]);
      expect(new Set(sent).size).toBe(5);
    });
  }), { numRuns: 20 });
});

it.skipIf(process.platform === "win32")("pause and move preserve independent shared holds and their revisions", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async reverse => {
    await fixture(async (runtime, backend, store, _profile, _events, sent) => {
      runtime.submit({ id: "waiting0", threadId: ref.threadId, prompt: "waiting0" });
      runtime.submit({ id: "waiting1", threadId: ref.threadId, prompt: "waiting1" });
      await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting0", paused: true });
      terminal(runtime, "turn-1", "failed"); await settle();
      // Independent causes are admitted through the actual shared engine;
      // owner controls must not answer either cause on the operator's behalf.
      const submit = runtime.turnQueue.submit.bind(runtime.turnQueue);
      runtime.turnQueue.submit = (entry: any) => runtime.turnQueue.submitHeld(entry, "separate-lock");
      runtime.submit({ id: "separate", threadId: ref.threadId, prompt: "separate" }); await runtime.work;
      runtime.turnQueue.submit = submit;
      const before = structuredClone(runtime.turnQueue.getAllQueuedEntries());
      const job = store.get("waiting0");
      expect(await backend.handle("backend.moveQueuedTurn", { queueEntryId: reverse ? "waiting0" : "waiting1", beforeQueueEntryId: reverse ? "waiting1" : "waiting0" })).toMatchObject({ disposition: "held" });
      expect(await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting1", paused: true })).toMatchObject({ disposition: "held" });
      expect(await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting0", paused: false })).toMatchObject({ disposition: "updated", paused: false, pauseRevision: 2 });
      expect(runtime.turnQueue.getAllQueuedEntries().map(({ id, holdReason, manualReleaseRequired }: any) => ({ id, holdReason, manualReleaseRequired }))).toEqual(before.map(({ id, holdReason, manualReleaseRequired }: any) => ({ id, holdReason, manualReleaseRequired })));
      await runtime.turnQueue.releaseHold(ref, (reason: string) => reason === "separate-lock"); await settle();
      expect(sent).toEqual(["active"]);
      expect(store.get("waiting0")).toEqual(job);
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("queued controls serialize with admission and shutdown without replaying accepted work", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async stop => {
    await fixture(async (runtime, backend, store, profile, _events, sent) => {
      const accepted = runtime.submit({ id: "waiting", threadId: ref.threadId, prompt: "waiting" });
      let unlock!: () => void, entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const barrier = runtime.turnQueue.withDispatchSuspended(ref, async () => { entered(); await new Promise<void>(resolve => { unlock = resolve; }); });
      await ready;
      const pause = backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting", paused: true }).catch((error: Error) => ({ error }));
      const move = backend.handle("backend.moveQueuedTurn", { queueEntryId: "waiting" }).catch((error: Error) => ({ error }));
      terminal(runtime, "turn-1");
      if (stop) await runtime.stop();
      unlock(); await barrier;
      expect((await pause).disposition).toBe(stop ? "not_found" : "updated");
      expect((await move).disposition).toBe(stop ? "not_found" : "unchanged");
      await settle(); expect(sent).toEqual(["active"]);
      if (!stop) {
        expect(await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting", paused: false })).toMatchObject({ disposition: "updated" });
        await settle(); expect(sent).toEqual(["active", "waiting"]);
        expect(await backend.handle("backend.moveQueuedTurn", { queueEntryId: "waiting" })).toMatchObject({ disposition: "not_found" });
        await runtime.stop();
      }
      const { JobStore } = await load("store.js");
      runtime.store = new JobStore(path.dirname(store.directory), { version: 1, workspace: runtime.workspace, codexHome: path.join(runtime.workspace, "codex") }, profile);
      runtime.stopping = false;
      expect(runtime.submit({ id: "waiting", threadId: ref.threadId, prompt: "waiting" })).toMatchObject({ status: "unknown", fingerprint: accepted.fingerprint });
      expect(await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting", paused: false })).toMatchObject({ disposition: "not_found" });
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("concurrent control events never republish a cancelled entry or a superseded FIFO order", async () => {
  const commands = fc.array(fc.constantFrom("pause", "resume", "move-before", "move-back", "cancel"), { minLength: 2, maxLength: 8 });
  await fc.assert(fc.asyncProperty(fc.boolean(), commands, async (initiallyPaused, commands) => {
    await fixture(async (runtime, backend, store, _profile, events, sent) => {
      for (const id of ["waiting0", "waiting1"]) runtime.submit({ id, threadId: ref.threadId, prompt: id });
      if (initiallyPaused) await runtime.handle("pause", { id: "waiting0" });
      const accepted = store.get("waiting0");
      const offset = events.length;
      await Promise.all(commands.map(command => {
        if (command === "cancel") return backend.handle("backend.cancelQueuedTurn", { queueEntryId: "waiting0" });
        if (command.startsWith("move")) return backend.handle("backend.moveQueuedTurn", { queueEntryId: "waiting1", beforeQueueEntryId: command === "move-before" ? "waiting0" : undefined });
        return backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting0", paused: command === "pause" });
      }));
      const changes = events.slice(offset);
      const cancelled = changes.findIndex(event => event.method === "thread/turnQueue/updated" && event.params.status === "cancelled");
      if (commands.includes("cancel")) {
        expect(cancelled).toBeGreaterThanOrEqual(0);
        for (const event of changes.slice(cancelled + 1)) {
          if (event.method === "thread/turnQueue/updated") expect(event.params.queueEntryId).not.toBe("waiting0");
          if (event.method === "thread/turnQueue/reordered") expect(event.params.queueEntryIds).not.toContain("waiting0");
        }
        expect(store.get("waiting0")).toMatchObject({ status: "interrupted", fingerprint: accepted.fingerprint });
      } else expect(store.get("waiting0")).toEqual(accepted);
      // A viewer applies notifications in delivery order. Its waiting chips
      // must agree with the owning FIFO, including the latest pause revision.
      const visible = new Map<string, { paused: boolean; revision: number }>();
      for (const event of events) {
        if (event.method !== "thread/turnQueue/updated") continue;
        const { queueEntryId, status, paused, pauseRevision } = event.params;
        if (status === "queued" || status === "held") visible.set(queueEntryId, { paused: Boolean(paused), revision: pauseRevision ?? 0 });
        else visible.delete(queueEntryId);
      }
      const projection = backend.queueProjection({ protocol: 2, ref }).entries;
      expect([...visible].sort()).toEqual(projection.map((entry: any) => [entry.queueEntryId, { paused: Boolean(entry.paused), revision: entry.pauseRevision ?? 0 }]).sort());
      expect(sent).toEqual(["active"]);
    });
  }), { numRuns: 20, examples: [[false, ["pause", "cancel"]], [true, ["resume", "cancel"]], [false, ["pause", "move-before", "cancel"]]] });
});

it.skipIf(process.platform === "win32")("direct pause/cancel cannot recreate a cancelled waiting chip", async () => {
  await fixture(async (runtime, backend, store, _profile, events) => {
    runtime.submit({ id: "waiting", threadId: ref.threadId, prompt: "waiting" });
    await Promise.all([
      backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting", paused: true }),
      backend.handle("backend.cancelQueuedTurn", { queueEntryId: "waiting" }),
    ]);
    expect(events.filter(event => event.method === "thread/turnQueue/updated" && event.params.queueEntryId === "waiting").at(-1)?.params.status).toBe("cancelled");
    expect(backend.queueProjection({ protocol: 2, ref }).entries).toEqual([]);
    expect(store.get("waiting").status).toBe("interrupted");
  });
});

it.skipIf(process.platform === "win32")("a cancellation overtaking an order notification cannot restore its retired identity", async () => {
  await fixture(async (runtime, backend, _store, _profile, events) => {
    for (const id of ["waiting0", "waiting1"]) runtime.submit({ id, threadId: ref.threadId, prompt: id });
    await Promise.all([
      backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting0", paused: true }),
      backend.handle("backend.moveQueuedTurn", { queueEntryId: "waiting1", beforeQueueEntryId: "waiting0" }),
      backend.handle("backend.cancelQueuedTurn", { queueEntryId: "waiting0" }),
    ]);
    expect(events.filter(event => event.method === "thread/turnQueue/reordered").at(-1)?.params.queueEntryIds).toEqual(["waiting1"]);
  });
});

it.skipIf(process.platform === "win32")("resuming or moving waiting input cannot bypass the live host admission gates", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("lock", "project", "retired", "intake", "creating", "uncertain"), async gate => {
    await fixture(async (runtime, backend, store, _profile, _events, sent) => {
      const accepted = runtime.submit({ id: "waiting", threadId: ref.threadId, prompt: "waiting" });
      await runtime.handle("pause", { id: "waiting" });
      const owns = runtime.ownsThread, cwd = runtime.threadCwd;
      if (gate === "lock") runtime.threadLocked = () => true;
      if (gate === "project") runtime.threadCwd = () => path.join(runtime.workspace, "changed");
      if (gate === "retired") runtime.ownsThread = () => false;
      if (gate === "intake") runtime.intakeBusy = true;
      if (gate === "creating") backend.creating = true;
      if (gate === "uncertain") runtime.uncertain = true;
      terminal(runtime, "turn-1");
      await backend.handle("backend.moveQueuedTurn", { queueEntryId: "waiting" });
      await runtime.handle("resume", { id: "waiting" }); await settle();
      expect(sent).toEqual(["active"]);
      expect(store.get("waiting")).toEqual(accepted);
      expect(backend.queueProjection({ protocol: 2, ref }).entries).toMatchObject([{ queueEntryId: "waiting", pauseRevision: 2 }]);
      runtime.ownsThread = owns; runtime.threadCwd = cwd; runtime.threadLocked = () => false;
      runtime.intakeBusy = false; backend.creating = false; runtime.uncertain = false;
    });
  }), { numRuns: 12 });
});

it.skipIf(process.platform === "win32")("pause and order controls preserve the parent's same-FIFO held-release admission", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("pause", "resume", "move-before", "move-back"), fc.nat({ max: 2 }), fc.nat({ max: 2 }), async (command, target, observation) => {
    await fixture(async (runtime, backend, store, _profile, _events, sent) => {
      for (let n = 0; n < 3; n++) runtime.submit({ id: `waiting${n}`, threadId: ref.threadId, prompt: `waiting${n}` });
      terminal(runtime, "turn-1", "failed"); await settle();
      expect(backend.queuedTurns(ref.threadId).every((entry: any) => entry.manualReleaseRequired)).toBe(true);
      const accepted = store.get("waiting0");
      const observe = runtime.onEvent;
      let control: Promise<any> | undefined;
      runtime.onEvent = (event: any) => {
        observe(event);
        if (!control && event.method === "headless/queueChanged" && event.params.type === "queued"
          && event.params.entry.id === `waiting${observation}`) {
          const queueEntryId = `waiting${target}`;
          control = command.startsWith("move")
            ? backend.handle("backend.moveQueuedTurn", { queueEntryId, beforeQueueEntryId: command === "move-before" ? "waiting0" : undefined })
            : backend.handle("backend.setQueuedTurnPaused", { queueEntryId, paused: command === "pause" });
        }
      };
      const release = await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" });
      // The accepted Retry owns the first admission decision. A concurrent
      // control cannot spend its manual hold and turn it into a busy reply.
      expect(release).toMatchObject({ disposition: "started", turnId: "turn-2" });
      expect(control).toBeDefined();
      const result = await control;
      if (target === 0) expect(result.disposition).toBe("not_found");
      else expect(["updated", "unchanged", "moved", "anchor_not_found"]).toContain(result.disposition);
      expect(store.get("waiting0")).toMatchObject({ status: "running", fingerprint: accepted.fingerprint, turnId: "turn-2" });
      expect(runtime.dispatches.size).toBe(0);
      expect(runtime.queueRelease).toBeNull();
      expect(sent).toEqual(["active", "waiting0"]);
    });
  }), { numRuns: 12, examples: [["pause", 0, 0], ["resume", 1, 0], ["move-before", 1, 0], ["move-back", 0, 0]] });
});

it.skipIf(process.platform === "win32")("accepted confirmation failure after resume never exposes a retryable queue entry", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async early => {
    await fixture(async (runtime, backend, store, _profile, _events, sent) => {
      const accepted = runtime.submit({ id: "waiting", threadId: ref.threadId, prompt: "waiting" });
      await runtime.handle("pause", { id: "waiting" });
      terminal(runtime, "turn-1"); await settle();
      runtime.codex.startTurn = async () => {
        sent.push("waiting");
        if (early) terminal(runtime, "accepted");
        return { threadId: ref.threadId, turnId: "accepted" };
      };
      const save = store.save.bind(store);
      store.save = (job: any) => {
        if (job.id === "waiting" && job.status === "running") throw new Error("Confirmation refused");
        return save(job);
      };
      await runtime.handle("resume", { id: "waiting" }); await settle();
      expect(store.get("waiting")).toMatchObject({ status: "unknown", turnId: "accepted", fingerprint: accepted.fingerprint });
      expect(await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting", paused: false })).toMatchObject({ disposition: "not_found" });
      expect(await backend.handle("backend.moveQueuedTurn", { queueEntryId: "waiting" })).toMatchObject({ disposition: "not_found" });
      expect(runtime.submit({ id: "waiting", threadId: ref.threadId, prompt: "waiting" }).status).toBe("unknown");
      expect(sent).toEqual(["active", "waiting"]);
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("pause and ordering invalidate paged projections and make zero SQLite commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    await fixture(async (runtime, backend, store) => {
      for (let n = 0; n < 101; n++) runtime.submit({ id: `waiting${n}`, threadId: ref.threadId, prompt: `waiting${n}` });
      const page = backend.queueProjection({ protocol: 2, ref });
      expect(page.entries).toHaveLength(100); expect(page.complete).toBe(false);
      const accepted = [...store.jobs.values()];
      const { writes } = await measureSqliteWrites(async () => {
        for (let n = 0; n < 100; n++) {
          await runtime.handle("pause", { id: "waiting0" });
          await runtime.handle("pause", { id: "waiting0" });
          await runtime.handle("move", { id: "waiting1", before: "waiting0" });
          await runtime.handle("resume", { id: "waiting0" });
          await runtime.handle("move", { id: "waiting0", before: "waiting1" });
          backend.queueProjection({ protocol: 2, ref });
        }
      });
      expectSqliteWriteBudget({ budgetFile: "outpost-queue-pause-order-write-budgets.json", scenario: "waiting-controls", note: "100 pause/duplicate-pause/resume and two ordering requests plus projections while provider is active; in-memory changes only", writes });
      expect([...store.jobs.values()]).toEqual(accepted);
      expect(() => backend.queueProjection({ protocol: 2, ref, cursor: page.nextCursor })).toThrow("Queue changed");
      await expect(backend.handle("backend.setQueuedTurnPaused", { queueEntryId: "waiting0", paused: "false" })).rejects.toThrow("boolean");
      await expect(backend.handle("backend.moveQueuedTurn", { queueEntryId: "waiting0", beforeQueueEntryId: 42 })).rejects.toThrow("queue entry");
    });
  } finally { vi.unstubAllEnvs(); }
});

it.skipIf(process.platform === "win32")("actual Outpost held admission covers resumed jobs before synchronous review cancellation", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    await fixture(async (runtime, backend, store, _profile, events, sent) => {
      const accepted = ["older", "next"].map(id => runtime.submit({ id, threadId: ref.threadId, prompt: id }));
      await runtime.work;
      for (const job of accepted) await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: job.id, paused: true });
      terminal(runtime, "turn-1"); await settle();
      let cancellation: Promise<unknown> | undefined;
      runtime.onEvent = (event: any) => {
        backend.event(event);
        if (event.method === "headless/queueChanged" && event.params.type === "queued" && event.params.entry.id === "review") {
          cancellation = backend.handle("backend.cancelQueuedTurn", { queueEntryId: "review" });
        }
      };
      const { writes } = await measureSqliteWrites(async () => {
        for (const job of accepted) await backend.handle("backend.setQueuedTurnPaused", { queueEntryId: job.id, paused: false });
        runtime.submit({ id: "review", threadId: ref.threadId, prompt: "Target-ended guidance" },
          { manualReleaseRequired: true, holdReason: "Target turn ended; review required" });
        await runtime.work; await cancellation; await settle();
      });
      expectSqliteWriteBudget({ budgetFile: "queue-held-admission-write-budgets.json", scenario: "outpost",
        note: "Actual Runtime/HeadlessBackend resumed FIFO, held job acceptance and synchronous review cancellation plus real drains; setup excluded", writes });
      expect(sent).toEqual(["active"]);
      expect(backend.queueProjection({ protocol: 2, ref }).entries.map((entry: any) => [entry.queueEntryId, entry.manualReleaseRequired]))
        .toEqual([["older", true], ["next", true]]);
      for (const job of accepted) expect(store.get(job.id)).toEqual(job);
      expect(store.get("review").status).toBe("interrupted");
      expect(events.filter((event: any) => event.method === "thread/turnQueue/updated" && event.params.queueEntryId === "review").at(-1).params.status).toBe("cancelled");
      expect((await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "older" })).disposition).toBe("started");
      expect(sent).toEqual(["active", "older"]);
      await runtime.stop();
      expect(store.get("next").status).toBe("unknown");
      expect(store.get("next").fingerprint).toBe(accepted[1].fingerprint);
    });
  } finally { vi.unstubAllEnvs(); }
});
