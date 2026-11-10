import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("Electron unlock fences newer failure review and preserves a titled row's sender transition", async () => {
  let queueModule = "";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      queueModule = path.join(homeRoot, "production-queue.cjs");
      await build({ entryPoints: [path.resolve(specDir, "../../../packages/owner-core/src/thread-turn-queue.ts")],
        outfile: queueModule, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const results = await app.electronApp.evaluate(async (_electron, modulePath) => {
      const { ThreadTurnQueue: Queue } = process.getBuiltinModule("node:module").createRequire(modulePath)(modulePath) as { ThreadTurnQueue: typeof ThreadTurnQueue };
      const identity = { backend: "codex" as const, threadId: "invented-electron-owner" };
      const results = [];
      for (const overlap of ["failure", "title"] as const) {
        const sends: string[] = [];
        const senderState = new Map<string, string>();
        let active = true, armed = false, yieldingFailure = false;
        const queue = new Queue({
          isThreadActive: () => active,
          startTurn: async entry => { sends.push(entry.id); return { ...identity, turnId: entry.id }; },
          onLifecycle: async event => {
            if (event.type === "queued" || event.type === "held") senderState.set(event.entry.id, event.type);
            if (armed && event.type === "queued" && event.entry.id === "waiting-0" && !event.entry.manualReleaseRequired) {
              armed = false;
              if (overlap === "failure") {
                yieldingFailure = true;
                await queue.releaseThread({ ...identity, turnId: "new-native", status: "turn/failed", errorMessage: "new review" });
              } else queue.setQueuedEntryTitle("waiting-1", "Generated title");
            } else if (yieldingFailure && event.type === "held") {
              yieldingFailure = false;
              await new Promise<void>(resolve => setImmediate(resolve));
            }
          },
        });
        try {
          for (let index = 0; index < 2; index++) await queue.submit({ ...identity, id: `waiting-${index}`, origin: "manual",
            input: [{ type: "text", text: `Immutable input ${index}` }], paused: overlap === "title" || index === 0 });
          await queue.releaseThread({ ...identity, turnId: "prior-native", status: "turn/failed", errorMessage: "old lock" });
          active = false;
          queue.scheduleThreadDrain(identity);
          armed = true;
          await queue.releaseHold(identity, reason => reason === "old lock");
          await new Promise<void>(resolve => setImmediate(resolve));
          results.push({ overlap, sends, senderState: [...senderState.values()],
            waiting: queue.getQueuedEntries(identity).map(entry => ({ id: entry.id, held: entry.manualReleaseRequired === true, title: entry.title, input: entry.input })) });
        } finally { queue.close(); }
      }
      return results;
    }, queueModule);
    for (const result of results) {
      expect(result.sends).toEqual([]);
      expect(result.senderState).toEqual(result.overlap === "failure" ? ["held", "held"] : ["queued", "queued"]);
      expect(result.waiting).toEqual([0, 1].map(index => ({ id: `waiting-${index}`, held: result.overlap === "failure",
        title: result.overlap === "title" && index === 1 ? "Generated title" : undefined, input: [{ type: "text", text: `Immutable input ${index}` }] })));
    }
  } finally { await app.close(); }
});

for (const operation of ["Retry", "unlock"] as const) {
test(`Electron preserves newer queue review holds across asynchronous ${operation} publication and cancellation`, async () => {
  let queueModule = "";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      queueModule = path.join(homeRoot, "production-queue.cjs");
      await build({ entryPoints: [path.resolve(specDir, "../../../packages/owner-core/src/thread-turn-queue.ts")],
        outfile: queueModule, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.electronApp.evaluate(async (_electron, { modulePath, operation }) => {
      const { ThreadTurnQueue: Queue } = process.getBuiltinModule("node:module").createRequire(modulePath)(modulePath) as { ThreadTurnQueue: typeof ThreadTurnQueue };
      const identity = { backend: "codex" as const, threadId: "invented-electron-owner" };
      const sends: string[] = [];
      const latest = new Map<string, boolean>();
      let armed = false;
      const queue = new Queue({
        startTurn: async entry => { sends.push(entry.id); return { ...identity, turnId: entry.id }; },
        onLifecycle: async event => {
          if (event.type === "held" || event.type === "queued") latest.set(event.entry.id, event.entry.manualReleaseRequired === true);
          if (armed && event.type === "queued" && !event.entry.manualReleaseRequired) {
            armed = false;
            // A real host event turn separates publication from the incoming
            // held result. Its new review must remain actionable afterward.
            await new Promise<void>(resolve => setImmediate(resolve));
            await queue.submitHeld({ ...identity, id: "new-result", origin: "manual", input: [] }, "new review");
          }
        },
      });
      try {
        for (const id of ["older-0", "older-1", "older-2"]) await queue.submitHeld({ ...identity, id, origin: "manual", input: [] }, "old review");
        armed = true;
        const release = operation === "Retry"
          ? (await queue.releaseEntryWithDisposition("older-0")).disposition
          : await queue.releaseHold(identity, reason => reason === "old review");
        const held = queue.getQueuedEntries(identity).map(entry => ({ id: entry.id, held: entry.manualReleaseRequired, reason: entry.holdReason }));
        const heldEvents = [...latest.values()];
        queue.cancelEntryWithDisposition("new-result");
        await new Promise<void>(resolve => setImmediate(resolve));
        const beforeExplicitRetry = [...sends];
        const explicitRetry = await queue.releaseEntryWithDisposition("older-0");
        queue.close();
        await queue.releaseThread({ ...identity, turnId: "older-0", status: "turn/completed" });
        await new Promise<void>(resolve => setImmediate(resolve));
        return { release, held, heldEvents, beforeExplicitRetry, explicitRetry: explicitRetry.disposition, sends };
      } finally { queue.close(); }
    }, { modulePath: queueModule, operation });
    expect(result.release).toBe(operation === "Retry" ? "busy" : true);
    expect(result.held).toEqual(["new-result", "older-0", "older-1", "older-2"].map(id => ({ id, held: true, reason: "new review" })));
    expect(result.heldEvents.every(Boolean)).toBe(true);
    expect(result.beforeExplicitRetry).toEqual([]);
    expect(result.explicitRetry).toBe("started");
    expect(result.sends).toEqual(["older-0"]);
    const titled = await app.electronApp.evaluate(async (_electron, modulePath) => {
      const { ThreadTurnQueue: Queue } = process.getBuiltinModule("node:module").createRequire(modulePath)(modulePath) as { ThreadTurnQueue: typeof ThreadTurnQueue };
      const identity = { backend: "codex" as const, threadId: "invented-title-owner" };
      const released: Array<{ id: string; title?: string }> = [];
      let armed = false;
      const queue = new Queue({
        startTurn: async entry => ({ ...identity, turnId: entry.id }),
        onLifecycle: async event => {
          if (!armed || event.type !== "queued" || event.entry.manualReleaseRequired) return;
          released.push({ id: event.entry.id, title: event.entry.title });
          if (event.entry.id !== "first") return;
          await new Promise<void>(resolve => setImmediate(resolve));
          queue.setQueuedEntryTitle("later", "Invented generated title");
          queue.cancelEntryWithDisposition("cancelled");
        },
      });
      try {
        for (const id of ["first", "later", "cancelled"]) {
          await queue.submitHeld({ ...identity, id, origin: "manual", input: [] }, "Review the previous failure");
        }
        armed = true;
        const retry = await queue.releaseEntryWithDisposition("first");
        return { disposition: retry.disposition, released, waiting: queue.getQueuedEntries(identity).map(entry => entry.id) };
      } finally { queue.close(); }
    }, queueModule);
    expect(titled).toEqual({ disposition: "started", waiting: ["later"], released: [
      { id: "first", title: undefined }, { id: "later", title: "Invented generated title" },
    ] });
  } finally { await app.close(); }
});
}
