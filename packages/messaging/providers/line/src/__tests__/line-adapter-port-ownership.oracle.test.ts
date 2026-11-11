import { describe, expect, it } from "vitest";
import { LineAdapter } from "../line-adapter.ts";
import { postLineWebhook } from "./helpers/line-webhook.ts";
import { takeEveryReleasedPort } from "./helpers/take-every-released-port.ts";

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
