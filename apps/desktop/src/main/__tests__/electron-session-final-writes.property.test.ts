import fc from "fast-check";
import { expect, it } from "vitest";
import { closeElectronWithSessionDrain } from "../../../e2e/fixtures/electron-app";
import { createCloseHarness } from "./fixtures/electron-close-harness";
import { ElectronQuitModel } from "./helpers/electron-quit-model";

it("native quit observes the final writes produced by renderer closure", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 3 }),
    fc.integer({ min: 0, max: 4 }),
    async (count, turns) => {
      const written = Array.from({ length: count }, () => 0);
      const flushed = written.slice();
      const model = new ElectronQuitModel(written.map((_, index) => `renderer-${index}`));
      for (const [index, window] of model.browserWindows().entries()) {
        // Renderer unload can produce a final storage write. A drain made
        // before this transition cannot own that write's completion.
        window.once("closed", () => { written[index] += 1; });
      }
      let atNativeQuit: number[] = [];
      const nativeQuitAlreadyStarted: boolean[] = [];
      const harness = createCloseHarness(written.map((_, index) => ({
        closeAllConnections: async () => undefined,
        cookies: { flushStore: async () => undefined },
        clearData: async () => {
          nativeQuitAlreadyStarted.push(model.emitted.includes("will-quit"));
          for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
          flushed[index] = written[index];
        },
      })), {
        quitModel: model,
        onNativeQuit: () => { atNativeQuit = flushed.slice(); },
      });
      await closeElectronWithSessionDrain(harness.electronApp);
      expect(atNativeQuit).toEqual(written);
      // Windows cache callbacks must finish before native quit begins. Holding
      // will-quit is too late, even though the JavaScript session still exists.
      expect(nativeQuitAlreadyStarted).toEqual(written.map(() => false));
      expect(written).toEqual(Array.from({ length: count }, () => 1));
      expect(model.reentrantQuits).toBe(0);
    },
  ), { numRuns: 25 });
});
