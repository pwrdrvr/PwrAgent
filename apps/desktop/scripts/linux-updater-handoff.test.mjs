import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "vitest";

const require = createRequire(import.meta.url);

test.each(["Deb", "Rpm", "Pacman"])("managed %s installation permits authorization retry without scheduling relaunch or quit", async (format) => {
  const updaters = await import("../src/main/linux-package-updater.ts");
  const Updater = updaters[`Managed${format}Updater`];
  const sequence = [];
  const updater = new Updater(null, {
    version: "1.0.0", name: "PwrAgent", isPackaged: true,
    relaunch: () => sequence.push("relaunch"),
    quit: () => sequence.push("quit"),
  });
  updater.logger = { info() {}, warn() {}, error() {} };
  updater.downloadedUpdateHelper = {
    file: `/fixture/PwrAgent.${format.toLowerCase()}`,
    downloadedFileInfo: {},
  };
  updater.hasCommand = () => true;
  updater.detectPackageManager = () => format === "Deb" ? "dpkg" : "rpm";
  let authorize = false;
  updater.runCommandWithSudoIfNeeded = () => {
    if (!authorize) throw new Error("Not authorized");
    sequence.push("install");
  };
  let failure;
  const captureError = (error) => { failure = error; };
  updater.once("error", captureError);
  assert.equal(updater.authorizeInstall(false), false);
  updater.removeListener("error", captureError);
  assert.match(failure.message, /Not authorized/);
  await new Promise(setImmediate);
  assert.deepEqual(sequence, []);

  authorize = true;
  assert.equal(updater.authorizeInstall(false), true);
  await new Promise(setImmediate);
  assert.deepEqual(sequence, ["install"]);
});


test.each(["rpm", "dnf", "yum", "zypper"].flatMap((manager) => [
  { manager, downgrade: true },
  { manager, downgrade: false },
]))("managed RPM uses the $manager command with downgrade=$downgrade", async ({ manager, downgrade }) => {
  const { ManagedRpmUpdater } = await import("../src/main/linux-package-updater.ts");
  const { LinuxUpdater } = require("electron-updater/out/LinuxUpdater");
  const originalRunner = LinuxUpdater.prototype.runCommandWithSudoIfNeeded;
  const commands = [];
  LinuxUpdater.prototype.runCommandWithSudoIfNeeded = (args) => { commands.push(args); return ""; };
  try {
    const updater = new ManagedRpmUpdater(null, {
      version: "2.0.0", name: "PwrAgent", isPackaged: true,
      relaunch: () => assert.fail("authorization must not relaunch"),
      quit: () => assert.fail("authorization must not quit"),
    });
    updater.logger = { info() {}, warn() {}, error() {} };
    updater.downloadedUpdateHelper = { file: "/fixture/PwrAgent.rpm", downloadedFileInfo: {} };
    updater.detectPackageManager = () => manager;
    assert.equal(updater.authorizeInstall(downgrade), true);
    const [command] = commands;
    assert.equal(command[0], manager);
    if (manager === "rpm") assert.equal(command.includes("--oldpackage"), downgrade);
    if (manager === "dnf" || manager === "yum") assert.equal(command[1], downgrade ? "downgrade" : "install");
    if (manager === "zypper") assert.ok(command.includes("-f"));
    assert.equal(command.at(-1), "/fixture/PwrAgent.rpm");
  } finally {
    LinuxUpdater.prototype.runCommandWithSudoIfNeeded = originalRunner;
  }
});
