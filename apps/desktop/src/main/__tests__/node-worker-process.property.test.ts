import { EventEmitter, once } from "node:events";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { forkOwnerWorker } from "../node-worker-process";

it("preserves generated IPC payloads and the supplied environment until the child closes", async () => {
  const env = { ...process.env, PWRAGENT_WORKER_TEST_VALUE: "invented worker environment" };
  const before = { ...env };
  const child = forkOwnerWorker(path.join(import.meta.dirname, "fixtures/node-worker-echo.cjs"), env);
  const replies = new EventEmitter();
  child.on("message", (reply) => { replies.emit("reply", reply); });
  const stopped = new Promise<number>((resolve) => { child.once("exit", resolve); });
  try {
    await fc.assert(fc.asyncProperty(fc.jsonValue(), async (value) => {
      const reply = once(replies, "reply");
      child.postMessage({ value });
      expect((await reply)[0]).toEqual({ value, inherited: env.PWRAGENT_WORKER_TEST_VALUE });
    }));
    expect(env).toEqual(before);
    child.postMessage({ stop: true });
    expect(await stopped).toBe(0);
  } finally {
    child.kill();
    await stopped;
  }
});
