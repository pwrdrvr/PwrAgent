// TEMPORARY verification probe; remove before merge.
// Crashes a bare windowed Electron with the CrashReporter DialogType set to
// none, then (control) with it unset, waiting a full minute in each phase for
// a report and a UserNotificationCenter dialog. Every dialog the probe causes
// is dismissed before it exits. Restores the original DialogType.
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const electron = createRequire(path.resolve("apps/desktop/package.json"))("electron");
const root = mkdtempSync(path.join(os.tmpdir(), "crash-dialog-probe-"));
const helper = path.join(root, "activate");
execFileSync("xcrun", ["swiftc", "apps/desktop/e2e/fixtures/macos-window-activation.swift", "-o", helper], { timeout: 120_000, stdio: "ignore" });
const frontmost = async () => JSON.parse((await run(helper, ["frontmost"])).stdout).bundle;
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
const reportsDir = path.join(os.homedir(), "Library/Logs/DiagnosticReports");
const reports = () => new Set(readdirSync(reportsDir).filter((name) => name.startsWith("Electron") && name.endsWith(".ips")));
const unc = () => execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" }).split("\n")
  .filter((line) => line.endsWith("/UserNotificationCenter.app/Contents/MacOS/UserNotificationCenter"))
  .map((line) => Number(line.trim().split(/\s+/)[0]));
const dialogType = () => {
  try { return execFileSync("defaults", ["read", "com.apple.CrashReporter", "DialogType"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};
const setDialogType = (value) => {
  if (value === null) {
    try { execFileSync("defaults", ["delete", "com.apple.CrashReporter", "DialogType"], { stdio: "ignore" }); } catch {}
  } else {
    execFileSync("defaults", ["write", "com.apple.CrashReporter", "DialogType", "-string", value]);
  }
};
const preexisting = new Set(unc());
const dismissed = [];
// Dismiss every dialog this probe caused, until none comes back.
async function sweep() {
  for (let round = 0; round < 6; round += 1) {
    const ours = unc().filter((pid) => !preexisting.has(pid));
    if (ours.length === 0 && round > 0) return;
    for (const pid of ours) {
      try { process.kill(pid, "SIGTERM"); dismissed.push(pid); } catch {}
    }
    await sleep(5000);
  }
}

async function crash(label, value) {
  setDialogType(value);
  const reportsBefore = reports();
  const uncBefore = new Set(unc());
  const child = spawn(electron, [app], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) resolve(); });
    setTimeout(() => reject(new Error(`${label}: probe app never became ready`)), 30_000);
  });
  const result = { label, dialogType: dialogType(), frontmostBeforeCrash: await frontmost() };
  const crashedAt = Date.now();
  process.kill(child.pid, "SIGSEGV");
  for (let second = 0; second < 60; second += 1) {
    await sleep(1000);
    const report = [...reports()].find((name) => !reportsBefore.has(name));
    if (report && !result.report) { result.report = report; result.reportAfterSeconds = Math.round((Date.now() - crashedAt) / 1000); }
    const dialog = unc().filter((pid) => !uncBefore.has(pid));
    if (dialog.length > 0 && !result.dialog) { result.dialog = dialog; result.dialogAfterSeconds = Math.round((Date.now() - crashedAt) / 1000); }
  }
  result.frontmostAfterWait = await frontmost();
  await sweep();
  result.frontmostAfterSweep = await frontmost();
  return result;
}

const original = dialogType();
const results = [];
try {
  results.push(await crash("DialogType none", "none"));
  results.push(await crash("control: DialogType unset", null));
} finally {
  setDialogType(original);
  await sweep();
}
const left = unc().filter((pid) => !preexisting.has(pid));
console.log(JSON.stringify({ original, preexisting: [...preexisting], dismissed, left, results }));
for (const result of results) {
  console.log(`::notice title=Crash dialog probe::${result.label}: report=${result.report ?? "none"} (${result.reportAfterSeconds ?? "-"}s) dialog=${result.dialog?.join(",") ?? "none"} (${result.dialogAfterSeconds ?? "-"}s) frontmost=${result.frontmostAfterWait} afterSweep=${result.frontmostAfterSweep}`);
}
if (left.length > 0) {
  console.log(`::error title=Crash dialog probe::left UserNotificationCenter ${left.join(",")} running`);
}
