import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

for (const tracked of [false, true]) test(tracked
  ? "Electron retains the tracked owner through terminal publication before holding failed-turn successors"
  : "Electron keeps every failed-turn successor held when publication cancels its preceding row", async () => {
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
    const result = await app.electronApp.evaluate(async (_electron, { modulePath, tracked }) => {
      const { ThreadTurnQueue: Queue } = process.getBuiltinModule("node:module").createRequire(modulePath)(modulePath) as { ThreadTurnQueue: typeof ThreadTurnQueue };
      const identity = { backend: "codex" as const, threadId: "invented-failed-electron-owner" };
      const sends: string[] = [];
      const latest = new Map<string, boolean>();
      let active = !tracked, armed = false;
      const drain = async () => await new Promise<void>(resolve => setImmediate(resolve));
      const queue = new Queue({
        isThreadActive: () => active,
        startTurn: async entry => { sends.push(entry.id); return { ...identity, turnId: entry.id }; },
        onLifecycle: async event => {
          if (event.type === "held" || event.type === "queued") latest.set(event.entry.id, event.entry.manualReleaseRequired === true);
          if (event.type === "cancelled") latest.delete(event.entry.id);
          if (armed && (tracked ? event.type === "terminal" && event.entry.id === "owner" : event.type === "held")) {
            armed = false;
            queue.setQueuedEntryTitle("next", "Generated queued title");
            queue.cancelEntryWithDisposition(tracked ? "older" : event.entry.id);
            // Let Electron's real event loop run the cancellation drain while
            // the first failure-hold publication is still outstanding.
            await drain();
          }
        },
      });
      try {
        if (tracked) await queue.submit({ ...identity, id: "owner", origin: "manual", input: [] });
        active = true;
        for (const id of ["older", "next", "last"]) await queue.submit({ ...identity, id, origin: "manual", input: [{ type: "text", text: `Accepted ${id}` }] });
        armed = true;
        const failure = queue.releaseThread({ ...identity, turnId: tracked ? "owner" : "prior-native", status: "turn/failed", errorMessage: "Review the failed turn" });
        active = false;
        await failure;
        await drain();
        const beforeRetry = [...sends];
        const held = queue.getQueuedEntries(identity).map(entry => ({ id: entry.id, held: entry.manualReleaseRequired, input: entry.input, title: entry.title }));
        const eventsHeld = [...latest.values()];
        const retry = await queue.releaseEntryWithDisposition("next");
        queue.close();
        await queue.releaseThread({ ...identity, turnId: "next", status: "turn/completed" });
        await drain();
        return { beforeRetry, held, eventsHeld, retry: retry.disposition, sends };
      } finally { queue.close(); }
    }, { modulePath: queueModule, tracked });
    expect(result.beforeRetry).toEqual(tracked ? ["owner"] : []);
    expect(result.held).toEqual(["next", "last"].map(id => ({ id, held: true, input: [{ type: "text", text: `Accepted ${id}` }],
      title: id === "next" ? "Generated queued title" : undefined })));
    expect(result.eventsHeld).toEqual([true, true]);
    expect(result.retry).toBe("started");
    expect(result.sends).toEqual(tracked ? ["owner", "next"] : ["next"]);
  } finally { await app.close(); }
});
