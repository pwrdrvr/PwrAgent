// Manual Windows diagnostic: no product app or user profile is loaded.
import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { _electron } = require("@playwright/test");
const { values } = parseArgs({ options: {
  "output-dir": { type: "string" },
  "handle-exe": { type: "string" },
} });
if (process.platform !== "win32") throw new Error("This probe requires Windows.");
const directory = path.resolve(values["output-dir"] ?? path.join(
  path.dirname(fileURLToPath(import.meta.url)), "../test-results/windows-pipe-inheritance", String(Date.now()),
));
await mkdir(path.dirname(directory), { recursive: true });
await mkdir(directory);
const events = [];

const record = (data) => {
  const event = { at: Date.now(), ...data };
  events.push(event);
  appendFileSync(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`);
};
const exists = async (name) => access(path.join(directory, name)).then(() => true, () => false);
async function waitForFile(name, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await exists(name)) {
    if (Date.now() >= deadline) throw new Error(`Probe did not write ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return JSON.parse(await readFile(path.join(directory, name), "utf8"));
}
async function bounded(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function snapshot(pids, label) {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter '${filter}' -Property ProcessId,ParentProcessId,Name,CreationDate`
      + " | Select-Object ProcessId,ParentProcessId,Name,@{n='CreationTimeUtc';e={$_.CreationDate.ToUniversalTime().ToString('o')}},@{n='CreationTicks';e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress",
  ], { timeout: 3_000, windowsHide: true });
  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  await writeFile(path.join(directory, `${label}-processes.json`), `${JSON.stringify({ at: Date.now(), rows }, null, 2)}\n`);
  return rows;
}
async function handles(pid, label) {
  if (!values["handle-exe"]) return;
  // Read only. No Handle -c, taskkill, or system-wide handle scan.
  try {
    const { stdout, stderr } = await exec(path.resolve(values["handle-exe"]),
      ["-accepteula", "-nobanner", "-a", "-p", String(pid)],
      { timeout: 2_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    await writeFile(path.join(directory, `${label}-${pid}-handles.txt`), stdout);
    if (stderr) record({ kind: "handle-stderr", pid, label, stderr });
    return stdout;
  } catch (error) {
    record({ kind: "handle-error", pid, label, message: error.message, killed: error.killed, signal: error.signal });
  }
}
await writeFile(path.join(directory, "main.cjs"), `
const { app } = require("electron");
const fs = require("node:fs");
app.setPath("userData", process.env.PWRAGENT_PIPE_CONTROL_ROOT + "/chromium");
globalThis.spawnPipeControl = (node) => {
  const child = require("node:child_process").spawn(node, [process.env.PWRAGENT_PIPE_CONTROL_ROOT + "/intermediate.cjs"], {
    stdio: "ignore", windowsHide: true, env: process.env,
  });
  child.once("exit", (code, signal) => fs.writeFileSync(process.env.PWRAGENT_PIPE_CONTROL_ROOT + "/intermediate-exit.json", JSON.stringify({ at: Date.now(), pid: child.pid, code, signal })));
  return child.pid;
};
`);
await writeFile(path.join(directory, "intermediate.cjs"), `
const fs = require("node:fs");
const root = process.env.PWRAGENT_PIPE_CONTROL_ROOT;
const child = require("node:child_process").spawn(process.execPath, [root + "/retainer.cjs"], {
  stdio: "ignore", detached: true, windowsHide: true, env: process.env,
});
child.unref();
const deadline = Date.now() + 10000;
const timer = setInterval(() => {
  if (fs.existsSync(root + "/release-intermediate")) { clearInterval(timer); process.exit(0); }
  if (Date.now() > deadline) process.exit(1);
}, 25);
`);
await writeFile(path.join(directory, "retainer.cjs"), `
const fs = require("node:fs");
const root = process.env.PWRAGENT_PIPE_CONTROL_ROOT;
fs.writeFileSync(root + "/retainer.json", JSON.stringify({ at: Date.now(), pid: process.pid, ppid: process.ppid }));
setTimeout(() => {
  fs.writeFileSync(root + "/retainer-exit.json", JSON.stringify({ at: Date.now(), pid: process.pid }));
  process.exit(0);
}, 12000);
`);
let application;
let child;
try {
  application = await _electron.launch({
    executablePath: require("electron"),
    args: [path.join(directory, "main.cjs")],
    env: { ...process.env, PWRAGENT_PIPE_CONTROL_ROOT: directory },
    timeout: 30_000,
  });
  child = application.process();
  record({ kind: "launch", pid: child.pid, executable: child.spawnfile });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    record({ kind: "exit", pid: child.pid, code, signal, stdio: child.stdio.map((stream, fd) => ({
      fd, destroyed: stream?.destroyed, readableEnded: stream?.readableEnded,
    })) });
    resolve();
  }));
  child.once("close", () => record({ kind: "close", pid: child.pid }));
  for (const [fd, stream] of child.stdio.entries()) {
    if (!stream) continue;
    for (const kind of ["end", "close"]) stream.once(kind, () => record({ kind: `stdio-${kind}`, fd }));
  }
  const runtime = await application.evaluate(() => ({ pid: process.pid, versions: process.versions }));
  record({ kind: "runtime", ...runtime });
  if (runtime.pid !== child.pid) throw new Error("The launcher is not native Electron.");
  const intermediatePid = await application.evaluate((_electron, node) => globalThis.spawnPipeControl(node), process.execPath);
  const retainer = await waitForFile("retainer.json");
  const identities = await snapshot([process.pid, child.pid, intermediatePid, retainer.pid], "before-quit");
  const intermediateIdentity = identities.find((row) => row.ProcessId === intermediatePid);
  if (intermediateIdentity?.ParentProcessId !== child.pid) throw new Error("Intermediate ancestry was not observed.");
  const retainerIdentity = identities.find((row) => row.ProcessId === retainer.pid);
  if (!retainerIdentity || retainerIdentity.ParentProcessId !== intermediatePid) throw new Error("Retainer ancestry was not observed.");
  const mainHandles = await handles(child.pid, "main-before-quit");
  const beforeRetainerHandles = await handles(retainer.pid, "retainer-before-quit");
  await writeFile(path.join(directory, "release-intermediate"), "release\n");
  record({ kind: "intermediate-exit", ...(await waitForFile("intermediate-exit.json")) });
  record({ kind: "quit" });
  const closing = application.close();
  closing.catch(() => undefined);
  await bounded(exited, 10_000, "Electron did not exit after quit.");
  const afterExit = await snapshot([retainer.pid], "after-main-exit");
  const liveRetainer = afterExit.find((row) => row.ProcessId === retainer.pid && row.CreationTicks === retainerIdentity.CreationTicks);
  const afterRetainerHandles = liveRetainer ? await handles(retainer.pid, "retainer-after-main-exit") : undefined;
  await bounded(closing, 15_000, "The launcher pipes did not close.");
  const retainerExit = await waitForFile("retainer-exit.json");
  record({ kind: "retainer-natural-exit", ...retainerExit });
  const exit = events.find((event) => event.kind === "exit");
  const close = events.find((event) => event.kind === "close");
  const openFdsAtExit = exit.stdio.filter((stream) => stream.destroyed === false && stream.readableEnded === false).map((stream) => stream.fd);
  const pipeNames = (text) => new Set((text ?? "").match(/\\Device\\NamedPipe\\uv\\[^\s]+/g) ?? []);
  const beforePipes = pipeNames(beforeRetainerHandles);
  const afterPipes = pipeNames(afterRetainerHandles);
  const sharedLauncherPipeNames = [...pipeNames(mainHandles)].filter((name) =>
    name.endsWith(`-${process.pid}`) && beforePipes.has(name) && afterPipes.has(name));
  const summary = {
    directory, runtime, mainPid: child.pid, intermediatePid, retainerIdentity,
    sharedLauncherPipeNames,
    exitCode: exit.code, openFdsAtExit, exitToCloseMs: close.at - exit.at,
    retainerExitToCloseMs: close.at - retainerExit.at,
    retainerStillAliveAfterMainExit: Boolean(liveRetainer),
    reproduced: exit.code === 0 && openFdsAtExit.length === 4 && close.at - exit.at > 1_000 && Boolean(liveRetainer),
  };
  await writeFile(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
} catch (error) {
  record({ kind: "probe-error", message: error.message });
  // This ChildProcess retains the exact native process handle, avoiding a PID lookup.
  if (child && child.exitCode === null) child.kill("SIGKILL");
  process.exitCode = 1;
  console.error(error.message);
}
