import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { test } from "vitest";

const require = createRequire(import.meta.url);

test("the pinned DEB updater reports authorization failure synchronously and permits retry before teardown", async () => {
  // BaseUpdater's successful handoff emits through Electron's native updater.
  // Supply only that event sink: no Electron process or package manager runs.
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === "electron") return { autoUpdater: { emit() {} } };
    return originalLoad.call(this, id, ...args);
  };
  try {
    const { DebUpdater } = require("electron-updater");
    const sequence = [];
    const adapter = {
      version: "1.0.0",
      name: "PwrAgent",
      isPackaged: true,
      relaunch: () => sequence.push("relaunch"),
      quit: () => sequence.push("quit"),
    };
    const updater = new DebUpdater(null, adapter);
    updater.logger = { info() {}, warn() {}, error() {} };
    updater.downloadedUpdateHelper = {
      file: "/fixture/PwrAgent.deb",
      downloadedFileInfo: {},
    };
    updater.hasCommand = () => true;
    updater.detectPackageManager = () => "dpkg";
    let authorize = false;
    updater.runCommandWithSudoIfNeeded = () => {
      if (!authorize) throw new Error("Not authorized");
      sequence.push("install");
    };
    let failure;
    const captureError = (error) => { failure = error; };
    updater.once("error", captureError);
    updater.quitAndInstall();
    updater.removeListener("error", captureError);
    assert.match(failure.message, /Not authorized/);
    // No successful handoff was queued and no app teardown is necessary.
    await new Promise(setImmediate);
    assert.deepEqual(sequence, []);

    authorize = true;
    updater.quitAndInstall();
    assert.deepEqual(sequence, ["install", "relaunch"]);
    // The application can latch its preparation gate before the updater quits.
    sequence.push("latch");
    await new Promise(setImmediate);
    assert.deepEqual(sequence, ["install", "relaunch", "latch", "quit"]);
  } finally {
    Module._load = originalLoad;
  }
});
