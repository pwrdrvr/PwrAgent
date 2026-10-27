// TEMPORARY verification probe; remove before merge.
// Crashes a bare windowed Electron twice on the runner: once with the
// CrashReporter DialogType unset (control: a crash dialog is expected, and is
// then dismissed by stopping UserNotificationCenter), and once with
// DialogType none (no dialog expected). Leaves DialogType none in place.
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const electron = createRequire(path.resolve("apps/desktop/package.json"))("electron");
const root = mkdtempSync(path.join(os.tmpdir(), "crash-dialog-probe-"));
const helper = path.join(root, "activate");
execFileSync("xcrun", ["swiftc", "apps/desktop/e2e/fixtures/macos-window-activation.swift", "-o", helper], { timeout: 120_000 });
const frontmost = async () => JSON.parse((await run(helper, ["frontmost"])).stdout);
const app = path.join(root, "app");
execFileSync("mkdir", ["-p", app]);
writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "crash-dialog-probe", main: "main.js" }));
writeFileSync(path.join(app, "main.js"), `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 320, height: 200, show: false });
  w.loadURL("data:text/html,crash-dialog-probe");
  w.once("ready-to-show", () => { w.show(); app.focus({ steal: true }); setTimeout(() => console.log("ready"), 1500); });
});`);
const reports = path.join(os.homedir(), "Library/Logs/DiagnosticReports");
const unc = () => execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" }).split("\n")
  .filter((line) => line.endsWith("/UserNotificationCenter.app/Contents/MacOS/UserNotificationCenter"))
  .map((line) => Number(line.trim().split(/\s+/)[0]));
const dialogType = () => {
  try { return execFileSync("defaults", ["read", "com.apple.CrashReporter", "DialogType"], { encoding: "utf8" }).trim(); } catch { return null; }
};

async function crash(label) {
  const before = new Set(unc());
  const child = spawn(electron, [app], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) resolve(); });
    setTimeout(() => reject(new Error(`${label}: probe app never became ready`)), 30_000);
  });
  const result = { label, dialogType: dialogType(), uncBefore: [...before], frontmostBeforeCrash: await frontmost() };
  const crashedAt = Date.now();
  process.kill(child.pid, "SIGSEGV");
  for (let second = 0; second < 15; second += 1) {
    await sleep(1000);
    result.report ??= readdirSync(reports).filter((name) => name.endsWith(".ips")).map((name) => path.join(reports, name))
      .find((file) => statSync(file).mtimeMs >= crashedAt - 1000
        && readFileSync(file, "utf8").split("\n")[0].includes('"bundleID":"com.github.Electron"')) ?? undefined;
  }
  result.newUnc = unc().filter((pid) => !before.has(pid));
  result.frontmostAfterCrash = await frontmost();
  for (const pid of result.newUnc) {
    process.kill(pid, "SIGTERM");
  }
  if (result.newUnc.length > 0) {
    await sleep(2000);
    result.uncAfterDismiss = unc().filter((pid) => !before.has(pid));
    result.frontmostAfterDismiss = await frontmost();
  }
  return result;
}

const original = dialogType();
const results = [];
try {
  execFileSync("defaults", ["delete", "com.apple.CrashReporter", "DialogType"], { stdio: "ignore" });
} catch {}
results.push(await crash("control: DialogType unset"));
execFileSync("defaults", ["write", "com.apple.CrashReporter", "DialogType", "-string", "none"]);
results.push(await crash("DialogType none"));
console.log(JSON.stringify({ original, results }, null, 2));
for (const result of results) {
  console.log(`::notice title=Crash dialog probe::${result.label}: report=${result.report ? path.basename(result.report) : "none"} newUnc=${result.newUnc.join(",") || "none"} frontmostAfterCrash=${result.frontmostAfterCrash.bundle}`);
}
