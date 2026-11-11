import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { startOutpostDaemon } from "./helpers/outpost-daemon";

type CloseCallback = (error?: Error) => void;

/**
 * Plays the other test worker. Each loopback port this process releases is
 * bound by an interloper before the release completes, which is the worst
 * case of the window between a fixture choosing a port and the code under
 * test binding it. A fixture that holds every port it hands out never
 * releases one, so the interloper never matters.
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

describe.skipIf(process.platform === "win32")("Outpost fixture port ownership", () => {
  it("never hands the daemon a port the fixture does not hold", async () => {
    const adversary = takeEveryReleasedPort();
    try {
      const outpost = await startOutpostDaemon();
      try {
        // The enrolled viewer reaches the daemon on the port the invite named.
        await expect(outpost.client.listBackends({})).resolves.toHaveProperty("backends");
      } finally {
        await outpost.close();
      }
      expect(adversary.released).toEqual([]);
    } finally {
      await adversary.restore();
    }
  }, 60_000);
});
