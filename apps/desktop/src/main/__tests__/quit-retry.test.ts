import { describe, expect, it } from "vitest";

import { retryQuitAfterDispatch } from "../quit-retry";
import { ElectronQuitModel } from "./helpers/electron-quit-model";

/** Defer the first quit at `stage`, then retry it the way `retry` says. */
function deferOnce(
  model: ElectronQuitModel,
  stage: "before-quit" | "will-quit",
  retry: "microtask" | "after-dispatch",
): void {
  let deferred = false;
  model.on(stage, (event) => {
    if (deferred) return;
    deferred = true;
    event.preventDefault();
    if (retry === "microtask") void Promise.resolve().then(model.quit);
    else void Promise.resolve().then(() => retryQuitAfterDispatch(model.quit));
  });
}

// Each case is a row of scripts/electron-quit-reentry-probe.mjs, which
// measured the same outcome on Electron 41.10.7.
describe("Electron quit model", () => {
  it("loses a before-quit retry that settles in microtasks inside a native quit", async () => {
    const model = new ElectronQuitModel(["main"]);
    deferOnce(model, "before-quit", "microtask");
    await model.quitFromNativeTask();
    await model.settle();
    // Two passes, the window closes, and Electron reports window-all-closed
    // instead of will-quit.
    expect(model.emitted).toEqual([
      "before-quit",
      "before-quit",
      "close:main",
      "closed:main",
      "window-all-closed",
    ]);
    expect(model.reentrantQuits).toBe(1);
    expect(model.hasQuit).toBe(false);
  });

  it("does not lose the same retry when app.quit() came from JavaScript", async () => {
    const model = new ElectronQuitModel(["main"]);
    deferOnce(model, "before-quit", "microtask");
    model.quit();
    await model.settle();
    expect(model.reentrantQuits).toBe(0);
    expect(model.hasQuit).toBe(true);
  });

  it("loses a will-quit retry that settles in microtasks, however the quit started", async () => {
    for (const start of ["native", "js"] as const) {
      const model = new ElectronQuitModel(["main"]);
      deferOnce(model, "will-quit", "microtask");
      if (start === "native") await model.quitFromNativeTask();
      else model.quit();
      await model.settle();
      expect(model.emitted.at(-1)).toBe("will-quit");
      expect(model.hasQuit).toBe(false);
    }
  });

  it("quits from a retry issued in a window's closed listener", async () => {
    // The probe's `pwragent` row: the closed emit's checkpoint runs while the
    // window is still listed, so the retry closes nothing and the window's
    // removal then finds is_quitting_ set.
    const model = new ElectronQuitModel(["main"]);
    let deferred = false;
    model.on("before-quit", (event) => {
      if (deferred) return;
      deferred = true;
      event.preventDefault();
      const [window] = model.browserWindows();
      window.once("closed", () => void Promise.resolve().then(model.quit));
      window.close();
    });
    await model.quitFromNativeTask();
    await model.settle();
    expect(model.emitted).toEqual([
      "before-quit",
      "close:main",
      "closed:main",
      "before-quit",
      "will-quit",
      "quit",
    ]);
  });
});

describe("retryQuitAfterDispatch", () => {
  it.each(["before-quit", "will-quit"] as const)(
    "completes a native quit deferred at %s",
    async (stage) => {
      const model = new ElectronQuitModel(["main"]);
      deferOnce(model, stage, "after-dispatch");
      await model.quitFromNativeTask();
      await model.settle();
      expect(model.reentrantQuits).toBe(0);
      expect(model.hasQuit).toBe(true);
      expect(model.emitted).not.toContain("window-all-closed");
    },
  );

  it("does not run the quit before the current task returns", async () => {
    let quits = 0;
    retryQuitAfterDispatch(() => {
      quits += 1;
    });
    for (let i = 0; i < 100; i += 1) await Promise.resolve();
    expect(quits).toBe(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(quits).toBe(1);
  });
});
