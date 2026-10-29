// Runs only the installed CLI and a copied provider fixture; no workspace imports.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const [cli, fixture, temporary] = process.argv.slice(2);
const directory = (name) => { const result = path.join(temporary, name); mkdirSync(result); return result; };
const workspace = directory("w");
const codexHome = directory("c");
const data = directory("f");
const env = { ...process.env, PWRAGENT_HOME: directory("p"), PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data };
const children = [];
function launch(args) {
  const child = spawn(cli, args, { env, cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.output = "";
  child.errors = "";
  child.stdout.on("data", (chunk) => { child.output += chunk; });
  child.stderr.on("data", (chunk) => { child.errors += chunk; });
  child.done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  return child;
}
async function command(args) {
  const child = launch(args);
  assert.equal(await child.done, 0, child.errors);
  return child.output;
}
async function start() {
  const daemon = launch(["serve", "--workspace", workspace, "--codex-home", codexHome, "--codex-bin", fixture]);
  const deadline = Date.now() + 10000;
  while (!daemon.output.includes('"ready":true')) {
    assert.equal(daemon.exitCode, null, daemon.errors);
    assert.ok(Date.now() < deadline, "Installed daemon did not become ready");
    await delay(20);
  }
  return daemon;
}
async function stop(daemon) { daemon.kill("SIGTERM"); assert.equal(await daemon.done, 0, daemon.errors); }

try {
  assert.match(await command(["--help"]), /PwrAgent Headless/);
  // Exercise native input, resize and exit from the offline-installed tarball.
  const installedRequire = createRequire(realpathSync(cli));
  const terminal = installedRequire("node-pty").spawn("/bin/sh", [], { cwd: temporary, cols: 80, rows: 24 });
  let terminalExited = false;
  let terminalOutput = "";
  let terminalTimer;
  const dataListener = terminal.onData((data) => { terminalOutput += data; });
  try {
    const exited = new Promise((resolve, reject) => {
      terminalTimer = setTimeout(() => reject(new Error("Installed native PTY did not exit")), 10000);
      terminal.onExit((event) => { terminalExited = true; resolve(event); });
    });
    terminal.resize(100, 30);
    terminal.write("printf 'native-%s\\n' 'pty-ok'; exit\n");
    assert.equal((await exited).exitCode, 0);
    assert.ok(terminalOutput.includes("native-pty-ok"), terminalOutput);
  } finally {
    clearTimeout(terminalTimer);
    dataListener.dispose();
    if (!terminalExited) terminal.kill();
  }
  let daemon = await start();
  assert.equal(JSON.parse(await command(["status"])).activeJob, null);
  const prompt = path.join(temporary, "prompt.txt");
  writeFileSync(prompt, "packed-install");
  await command(["submit", "--id", "smoke", "--prompt-file", prompt, "--sandbox", "workspace-write"]);
  assert.equal(JSON.parse(await command(["wait", "--id", "smoke"])).status, "completed");
  assert.equal(readFileSync(path.join(workspace, "fixture-result.txt"), "utf8"), "packed-install");
  const transcript = JSON.parse(await command(["read", "--id", "smoke"]));
  assert.equal(transcript.thread.turns[0].items[0].text, "Fixture result");
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await command(["federation-invite", "--port", String(port), "--label", "Packed fixture"]);
  assert.ok(JSON.parse(await command(["federation-status"])).instanceId);
  await stop(daemon);
  daemon = await start();
  assert.equal(JSON.parse(await command(["show", "--id", "smoke"])).status, "completed");
  await command(["submit", "--id", "smoke", "--prompt-file", prompt, "--sandbox", "workspace-write"]);
  const calls = readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  await stop(daemon);
  console.log("Packed CLI smoke passed: native PTY input/resize/exit, help, mocked turn, transcript, federation, restart and duplicate submission");
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await child.done;
    }
  }
}
