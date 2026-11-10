import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

for (const steer of [false, true]) {
  test(`Electron preserves native acceptance through rejected started publication (steer=${steer})`, async () => {
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
      const result = await app.electronApp.evaluate(async (_electron, args) => {
        const { ThreadTurnQueue: Queue } = process.getBuiltinModule("node:module").createRequire(args.modulePath)(args.modulePath) as { ThreadTurnQueue: typeof ThreadTurnQueue };
        const identity = { backend: "codex" as const, threadId: "invented-accepted-owner" };
        const starts: string[] = [], steers: string[] = [], events: string[] = [];
        let active = true, gate = true;
        const drain = async () => await new Promise<void>(resolve => setImmediate(resolve));
        const queue = new Queue({
          isThreadActive: () => active,
          isDispatchHeld: () => gate,
          canSteerThread: () => args.steer && active,
          startTurn: async entry => { starts.push(entry.id); active = true; return { ...identity, turnId: entry.id === "accepted" ? "native" : "next-native" }; },
          steerTurn: async entry => { steers.push(entry.id); return { ...identity, turnId: "native" }; },
          onLifecycle: event => {
            events.push(`${event.type}:${event.entry.id}`);
            if (event.type === "started" && event.entry.id === "accepted") throw new Error("Started publication rejected");
          },
        });
        try {
          await (args.steer ? queue.submitSteer.bind(queue) : queue.submit.bind(queue))({ ...identity, id: "accepted", origin: "manual",
            input: [{ type: "text", text: "Immutable accepted input" }] });
          await queue.submit({ ...identity, id: "next", origin: "manual", input: [{ type: "text", text: "Immutable next input" }] });
          active = args.steer; gate = false;
          await queue.releaseThread(identity);
          await drain();
          const beforeTerminal = queue.getQueuedEntries(identity).map(entry => entry.id);
          const accepted = queue.cancelEntryWithDisposition("accepted");
          active = false;
          await queue.releaseThread({ ...identity, turnId: "native", status: "turn/failed", errorMessage: "Native failure" });
          await drain();
          const held = queue.getQueuedEntries(identity).map(entry => ({ id: entry.id, held: entry.manualReleaseRequired, reason: entry.holdReason, input: entry.input }));
          const retry = await queue.releaseEntryWithDisposition("next");
          queue.close();
          await queue.releaseThread({ ...identity, turnId: "next-native", status: "turn/completed" });
          await drain();
          return { beforeTerminal, accepted, held, retry: retry.disposition, starts, steers, events };
        } finally { queue.close(); }
      }, { modulePath: queueModule, steer });
      expect(result.beforeTerminal).toEqual(["next"]);
      expect(result.accepted).toMatchObject({ disposition: "already_admitted", turnId: "native" });
      expect(result.held).toEqual([{ id: "next", held: true, reason: "Native failure", input: [{ type: "text", text: "Immutable next input" }] }]);
      expect(result.retry).toBe("started");
      expect(result.starts).toEqual(steer ? ["next"] : ["accepted", "next"]);
      expect(result.steers).toEqual(steer ? ["accepted"] : []);
      expect(result.events).not.toContain("blocked:accepted");
      expect(result.events).not.toContain("failed:accepted");
    } finally { await app.close(); }
  });
}
