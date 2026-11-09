import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);

it("the actual Outpost admits one helper per first turn and explicit rename wins every completion ordering", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("none", "before", "during"), fc.constantFrom("ok", "invalid", "failed"), fc.integer({ min: 0, max: 5 }),
    async (renameAt, outcome, duplicates) => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-title-model-")));
      const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
      try {
        const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
        store.save({ version: 1, id: "first", fingerprint: "immutable", threadId: "thread", turnId: "turn", status: "running", sandbox: "read-only", createdAt: new Date(1).toISOString() });
        let complete!: (value: unknown) => void;
        let calls = 0;
        const helper = new Promise(resolve => { complete = resolve; });
        const backend = new HeadlessBackend({ workspace: root, store, onFailure(error: unknown) { throw error; }, codex: {
          generateTitle: async () => { calls++; return await helper; },
          renameThread: async () => ({ threadId: "thread" }),
        } }, () => {});
        const event = { method: "headless/turnStarted", params: { threadId: "thread", jobId: "first", prompt: "Please fix the login test" } };
        if (renameAt === "before") await backend.handle("renameThread", { threadId: "thread", name: "Operator title" });
        for (let i = 0; i <= duplicates; i++) backend.event(event);
        // Admission may yield through title eligibility; drive microtasks only.
        for (let i = 0; i < 12; i++) await Promise.resolve();
        expect(calls).toBe(renameAt === "before" ? 0 : 1);
        if (renameAt === "during") await backend.handle("renameThread", { threadId: "thread", name: "Operator title" });
        complete(outcome === "failed" ? { status: "failed", reason: "fixture refusal" }
          : { status: "ok", object: outcome === "invalid" ? { title: "" } : { title: "Repair login regression" } });
        await backend.titles.whenSettled();
        const expected = renameAt !== "none" ? { title: "Operator title", titleSource: "explicit" }
          : { title: outcome === "ok" ? "Repair login regression" : "Fix the login test", titleSource: "derived" };
        expect(backend.summary(backend.owned("thread"))).toMatchObject(expected);
        expect(store.get("first")).toMatchObject({ fingerprint: "immutable", threadId: "thread", turnId: "turn", status: "running" });
        backend.event(event);
        await backend.titles.whenSettled();
        expect(calls).toBe(renameAt === "before" ? 0 : 1);
      } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
    },
  ), { numRuns: 25 });
});

// The executable Runtime's private Unix directories support Linux and macOS.
// Shared title/naming and turn coordination keep their cross-platform suites.
it.skipIf(process.platform === "win32")("actual job preparation rechecks a handoff lock before inference and never replays durable acceptance", async () => {
  const [{ JobStore }, { Runtime }] = await Promise.all([load("store.js"), load("runtime.js")]);
  await fc.assert(fc.asyncProperty(fc.boolean(), async locked => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-turn-admission-")));
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
      const runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure(error: unknown) { throw error; } });
      let turns = 0;
      runtime.codex = { startThread: async () => ({ threadId: "created" }), startTurn: async () => { turns++; return { threadId: "created", turnId: "turn" }; } };
      runtime.threadLocked = () => locked;
      const submitted = runtime.submit({ id: "job", prompt: "first input" });
      await runtime.work;
      const accepted = store.get("job");
      expect(turns).toBe(locked ? 0 : 1);
      expect(accepted).toMatchObject({ fingerprint: submitted.fingerprint, threadId: "created", status: locked ? "failed" : "running" });
      expect(runtime.submit({ id: "job", prompt: "first input" })).toEqual(accepted);
      expect(turns).toBe(locked ? 0 : 1);
    } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 10 });
});
