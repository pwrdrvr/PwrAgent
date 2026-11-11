import net from "node:net";
import { vi } from "vitest";

type CloseCallback = (error?: Error) => void;

/**
 * Plays another test worker. Each loopback port this process releases is
 * bound by an interloper before the release completes, which is the worst
 * case of the window between a test choosing a port and the adapter binding
 * it. A test that only addresses the port the adapter itself bound never
 * releases one before the adapter listens, so the interloper never matters.
 */
export function takeEveryReleasedPort() {
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
