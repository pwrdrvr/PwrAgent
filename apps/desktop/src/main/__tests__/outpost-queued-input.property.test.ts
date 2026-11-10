import { createHash } from "node:crypto";
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
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const ref = { backend: "codex", threadId: "native" };
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise<void>(resolve => setImmediate(resolve)); };
const terminal = (runtime: any) => runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: runtime.store.get(runtime.active).turnId, status: "completed" } } });

async function fixture(work: (runtime: any, backend: any, store: any, profile: any, events: any[], sent: string[]) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-input-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  let runtime: any;
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const sent: string[] = [], events: any[] = [];
    runtime.codex = { startTurn: async ({ input }: any) => {
      sent.push(input[0].text);
      return { threadId: ref.threadId, turnId: sent.length === 1 ? "active-turn" : `turn-${sent.length}` };
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

it.skipIf(process.platform === "win32")("queued reads are detached snapshots; editing cancels acceptance and needs a new identity", async () => {
  const edits = fc.array(fc.record({ prompt: fc.string({ minLength: 1, maxLength: 500 }).filter(text => Boolean(text.trim())), forEdit: fc.boolean() }), { minLength: 3, maxLength: 8 });
  await fc.assert(fc.asyncProperty(edits, async commands => {
    await fixture(async (runtime, backend, store, _profile, events, sent) => {
      const expected = ["active"];
      // One admitted host owns the generated edit sequence. Reuse its real
      // profile rather than migrate and fsync a fresh profile for each edit.
      for (const [index, { prompt, forEdit }] of commands.entries()) {
        const messageOrigin = { kind: "agent", sourceThread: { threadId: "source", backend: "codex" } };
        const params = { id: `waiting${index}`, threadId: ref.threadId, prompt, messageOrigin };
        const accepted = runtime.submit(params);
        const request = { ...ref, queueEntryId: accepted.id, forEdit };
        const revision = backend.queueProjection({ protocol: 2, ref }).revision, eventCount = events.length;
        const snapshot = await backend.handle("backend.readQueuedTurn", request);
        const input = [{ type: "text", text: prompt }];
        expect(snapshot).toEqual({ queueEntryId: accepted.id, input, contentHash: hash(input), messageOrigin });
        snapshot.input[0].text += " caller mutation";
        snapshot.messageOrigin.sourceThread.threadId = "forged";
        expect(await backend.handle("backend.cancelQueuedTurn", { queueEntryId: accepted.id, expectedContentHash: hash(snapshot.input) })).toMatchObject({ disposition: "content_changed", cancelled: false });
        expect(await backend.handle("backend.readQueuedTurn", request)).toEqual({ queueEntryId: accepted.id, input, contentHash: hash(input), messageOrigin });
        expect(backend.queueProjection({ protocol: 2, ref }).revision).toBe(revision);
        expect(events).toHaveLength(eventCount);
        expect(store.get(accepted.id)).toEqual(accepted);
        expect(await backend.handle("backend.cancelQueuedTurn", { queueEntryId: accepted.id, expectedContentHash: snapshot.contentHash })).toMatchObject({ disposition: "cancelled", cancelled: true });
        expect(store.get(accepted.id)).toMatchObject({ status: "interrupted", fingerprint: accepted.fingerprint });
        expect(runtime.submit(params)).toMatchObject({ status: "interrupted", fingerprint: accepted.fingerprint });
        expect(() => runtime.submit({ ...params, prompt: `${prompt} edited` })).toThrow("different input");
        await expect(backend.handle("backend.readQueuedTurn", request)).rejects.toThrow("no longer waiting");
        const replacement = runtime.submit({ ...params, id: `replacement${index}`, prompt: `${prompt} edited`, messageOrigin: undefined });
        expect(replacement.fingerprint).not.toBe(accepted.fingerprint);
        expect(await backend.handle("backend.readQueuedTurn", { ...request, queueEntryId: replacement.id })).not.toHaveProperty("messageOrigin");
        terminal(runtime); await settle();
        expected.push(`${prompt} edited`);
        expect(sent).toEqual(expected);
        expect(store.get(accepted.id)).toMatchObject({ status: "interrupted", fingerprint: accepted.fingerprint });
      }
    });
  }), { numRuns: 6 });
});

it.skipIf(process.platform === "win32")("queued reads qualify backend and thread and do not release paused or held input", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async held => {
    await fixture(async (runtime, backend, store, _profile, _events, sent) => {
      const accepted = runtime.submit({ id: "waiting", threadId: ref.threadId, prompt: "waiting" });
      await runtime.handle("pause", { id: accepted.id });
      if (held) {
        runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: "active-turn", status: "failed" } } });
        await settle();
      }
      const request = { ...ref, queueEntryId: accepted.id, forEdit: true };
      const before = structuredClone(runtime.turnQueue.getAllQueuedEntries());
      expect(await backend.handle("backend.readQueuedTurn", request)).toMatchObject({ input: [{ type: "text", text: "waiting" }] });
      await expect(backend.handle("backend.readQueuedTurn", { ...request, threadId: "other" })).rejects.toThrow("no longer waiting");
      await expect(backend.handle("backend.readQueuedTurn", { ...request, backend: "claude" })).rejects.toThrow("Codex only");
      await expect(backend.handle("backend.readQueuedTurn", { ...request, backend: "all" })).rejects.toThrow();
      expect(runtime.turnQueue.getAllQueuedEntries()).toEqual(before);
      expect(store.get(accepted.id)).toEqual(accepted);
      expect(sent).toEqual(["active"]);
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("a snapshot cannot cancel provider admission or survive shutdown as replayable input", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async stop => {
    await fixture(async (runtime, backend, store, profile, _events, sent) => {
      const params = { id: "waiting", threadId: ref.threadId, prompt: "waiting" };
      const accepted = runtime.submit(params);
      const request = { ...ref, queueEntryId: accepted.id, forEdit: true };
      const snapshot = await backend.handle("backend.readQueuedTurn", request);
      if (stop) await runtime.stop();
      else { terminal(runtime); await settle(); }
      await expect(backend.handle("backend.readQueuedTurn", request)).rejects.toThrow();
      if (!stop) expect(await backend.handle("backend.cancelQueuedTurn", { queueEntryId: accepted.id, expectedContentHash: snapshot.contentHash })).toMatchObject({ disposition: "already_admitted", cancelled: false, turnId: "turn-2" });
      expect(snapshot.input).toEqual([{ type: "text", text: "waiting" }]);
      await runtime.stop();
      const { JobStore } = await load("store.js");
      runtime.store = new JobStore(path.dirname(store.directory), { version: 1, workspace: runtime.workspace, codexHome: path.join(runtime.workspace, "codex") }, profile);
      runtime.stopping = false;
      expect(runtime.submit(params)).toMatchObject({ status: "unknown", fingerprint: accepted.fingerprint });
      await expect(backend.handle("backend.readQueuedTurn", request)).rejects.toThrow("no longer waiting");
      expect(sent).toEqual(stop ? ["active"] : ["active", "waiting"]);
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("queued input inspection and stale edit cancellation make zero SQLite commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    await fixture(async (runtime, backend) => {
      runtime.submit({ id: "waiting", threadId: ref.threadId, prompt: "waiting" });
      const { writes } = await measureSqliteWrites(async () => {
        for (let n = 0; n < 1000; n++) {
          const snapshot = await backend.handle("backend.readQueuedTurn", { ...ref, queueEntryId: "waiting", forEdit: n % 2 === 0 });
          expect(snapshot.contentHash).toBe(hash(snapshot.input));
          expect(await backend.handle("backend.cancelQueuedTurn", { queueEntryId: "waiting", expectedContentHash: "stale" })).toMatchObject({ disposition: "content_changed" });
        }
      });
      expectSqliteWriteBudget({ budgetFile: "outpost-queued-input-write-budgets.json", scenario: "queued-input-reads", note: "1000 real owner snapshots (half forEdit) and 1000 stale content-hash cancellation refusals; acceptance excluded", writes });
    });
  } finally { vi.unstubAllEnvs(); }
});
