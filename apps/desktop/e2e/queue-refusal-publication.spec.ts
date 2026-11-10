import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("Electron holds refused-start successors before blocked publication can cancel the refused head", async () => {
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
    const result = await app.electronApp.evaluate(async (_electron, modulePath) => {
      const { ThreadTurnQueue: Queue } = process.getBuiltinModule("node:module").createRequire(modulePath)(modulePath) as { ThreadTurnQueue: typeof ThreadTurnQueue };
      const identity = { backend: "codex" as const, threadId: "invented-refused-owner" };
      const sends: string[] = [];
      const latest = new Map<string, boolean>();
      let active = true;
      const drain = async () => await new Promise<void>(resolve => setImmediate(resolve));
      const queue = new Queue({
        isThreadActive: () => active,
        startTurn: async entry => {
          if (entry.id === "refused") throw new Error("Provider refused submission");
          sends.push(entry.id); return { ...identity, turnId: entry.id };
        },
        onLifecycle: async event => {
          if (event.type === "held" || event.type === "queued") latest.set(event.entry.id, event.entry.manualReleaseRequired === true);
          if (event.type === "cancelled" || event.type === "started") latest.delete(event.entry.id);
          if (event.type === "blocked") {
            queue.cancelEntryWithDisposition("refused");
            await drain();
          }
        },
      });
      try {
        for (const id of ["refused", "next"]) await queue.submit({ ...identity, id, origin: "manual", input: [{ type: "text", text: `Accepted ${id}` }] });
        active = false;
        await queue.releaseThread(identity);
        await drain();
        const beforeRetry = [...sends];
        const held = queue.getQueuedEntries(identity).map(entry => ({ id: entry.id, held: entry.manualReleaseRequired, input: entry.input }));
        const projected = [...latest.entries()];
        const retry = await queue.releaseEntryWithDisposition("next");
        queue.close();
        await queue.releaseThread({ ...identity, turnId: "next", status: "turn/completed" });
        await drain();
        return { beforeRetry, held, projected, retry: retry.disposition, sends };
      } finally { queue.close(); }
    }, queueModule);
    expect(result.beforeRetry).toEqual([]);
    expect(result.held).toEqual([{ id: "next", held: true, input: [{ type: "text", text: "Accepted next" }] }]);
    expect(result.projected).toEqual([["next", true]]);
    expect(result.retry).toBe("started");
    expect(result.sends).toEqual(["next"]);
  } finally { await app.close(); }
});
