import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { LineAdapter } from "../line-adapter.ts";
import { postLineWebhook } from "./helpers/line-webhook.ts";

type CloseCallback = (error?: Error) => void;

/**
 * Plays another test worker. Each loopback port this process releases is
 * bound by an interloper before the release completes, which is the worst
 * case of the window between a test choosing a port and the adapter binding
 * it. A test that only addresses the port the adapter itself bound never
 * releases one before the adapter listens, so the interloper never matters.
 */
function takeEveryReleasedPort() {
  const interlopers: net.Server[] = [];
  const released: number[] = [];
  const originalClose = net.Server.prototype.close;
  const spy = vi.spyOn(net.Server.prototype, "close").mockImplementation(function (this: net.Server, callback?: CloseCallback) {
    const address = this.address();
    return originalClose.call(this, (error?: Error) => {
      if (error || !address || typeof address === "string") {
        callback?.(error);
        return;
      }
      released.push(address.port);
      const interloper = net.createServer();
      interlopers.push(interloper);
      interloper.once("error", () => callback?.());
      interloper.listen(address.port, address.address, () => callback?.());
    });
  });
  return {
    released,
    async restore() {
      spy.mockRestore();
      await Promise.all(interlopers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    },
  };
}

describe("LINE adapter test port ownership", () => {
  it("never hands the adapter a port the test does not hold", async () => {
    const adversary = takeEveryReleasedPort();
    try {
      // Started the way line-adapter.test.ts starts every webhook listener.
      const adapter = new LineAdapter({
        listenPort: 0,
        callbackHandleStore: {
          resolveCallbackHandle: async () => undefined,
          upsertCallbackHandle: async (record) => record,
        },
        config: {
          authorizedActorIds: [],
          callbackBaseUrl: "http://127.0.0.1:47822/",
          channel: "line",
          channelSecret: "secret",
        },
      });
      try {
        await adapter.start(async () => undefined);
        const response = await postLineWebhook(adapter, "secret", { events: [] });
        expect(response.status).toBe(200);
        // Checked before stop(): the adapter's own close is a release too.
        expect(adversary.released).toEqual([]);
      } finally {
        await adapter.stop();
      }
    } finally {
      await adversary.restore();
    }
  });
});
