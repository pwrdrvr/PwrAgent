import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { call } from "../src/client.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const cli = process.env.PWRAGENT_TEST_CLI || fileURLToPath(new URL("../bin/pwragent.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/codex.js", import.meta.url));
const timeout = 10000;

export async function eventually(check) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error("Condition did not become true");
}

export async function setup(t) {
  // All test artifacts stay inside the assigned checkout. Use a short root
  // because Unix-domain socket addresses have a small platform limit.
  const local = path.join(repo, ".local");
  mkdirSync(local, { recursive: true });
  const root = mkdtempSync(path.join(local, "h"));
  const workspace = path.join(root, "w");
  const home = path.join(root, "c");
  const data = path.join(root, "f");
  for (const directory of [workspace, home, data]) mkdirSync(directory);
  chmodSync(fixture, 0o755);
  const directory = path.join(root, "profiles/t/state/headless");
  const env = { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data };
  const children = [];
  function launch(args) {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.output = "";
    child.errors = "";
    child.stdout.on("data", (chunk) => { child.output += chunk; });
    child.stderr.on("data", (chunk) => { child.errors += chunk; });
    child.done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    children.push(child);
    return child;
  }
  const serveArgs = ["serve", "--workspace", workspace, "--codex-home", home, "--codex-bin", fixture];
  async function start() {
    const child = launch(serveArgs);
    await eventually(() => {
      if (child.exitCode !== null) throw new Error(`Daemon failed: ${child.errors}`);
      return child.output.includes('"ready":true');
    });
    return child;
  }
  async function stop(child) { child.kill("SIGTERM"); return child.done; }
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) await stop(child);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const daemon = await start();
  const rpc = (method, params) => call(directory, method, params);
  const submit = (id, prompt, extra = {}) => rpc("submit", { id, prompt, ...extra });
  const finished = (id) => eventually(async () => {
    const job = await rpc("show", { id });
    return ["starting", "running", "interrupting"].includes(job.status) ? null : job;
  });
  const calls = () => readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return { root, workspace, home, data, directory, daemon, start, stop, rpc, submit, finished, calls, launch, serveArgs };
}
