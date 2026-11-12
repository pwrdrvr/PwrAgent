// Runs the installed Node owner and a copied, test-owned App Server.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const [cli, fixture, temporary] = process.argv.slice(2);
const directory = name => { const value = path.join(temporary, name); fs.mkdirSync(value); return value; };
const workspace = directory("w"), home = directory("c"), data = directory("f");
const env = { ...process.env, PWRAGENT_HOME: directory("p"), PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data };
const installed = createRequire(fs.realpathSync(cli));
const owner = installed("../dist/index.js");
const installedRoot = path.resolve(path.dirname(fs.realpathSync(cli)), "..");
const git = spawnSync(path.join(installedRoot, "resources/git/bin/git"), ["--version"], { encoding: "utf8" });
assert.equal(git.status, 0, git.error?.message ?? git.stderr);
assert.match(git.stdout, /git version/);
const lock = path.join(temporary, "native-helper.lock"); fs.writeFileSync(lock, "", { mode: 0o600 });
const relay = spawnSync(path.join(installedRoot, "resources/mcp-ipc-relay/mcp-ipc-relay"), ["--maintenance-lock", lock], { input: "", encoding: "utf8" });
assert.equal(relay.status, 0, relay.error?.message ?? relay.stderr);
assert.equal(relay.stdout, "\x01");

const database = new (installed("better-sqlite3"))(":memory:");
assert.equal(database.prepare("SELECT 42 AS n").get().n, 42); database.close();
assert.ok(installed("@napi-rs/canvas").createCanvas(1, 1).toBuffer("image/png").length > 0);
fs.accessSync(installed.resolve("pdfjs-dist/wasm/openjpeg.wasm"));
const pdfjs = await import(pathToFileURL(installed.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
const drawing = "0 0 100 100 re 0.2 0.4 0.6 rg f\n";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << >> >>",
  `<< /Length ${Buffer.byteLength(drawing)} >>\nstream\n${drawing}endstream`];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const loading = pdfjs.getDocument({ data: new Uint8Array(Buffer.from(pdf)),
  wasmUrl: pathToFileURL(path.dirname(installed.resolve("pdfjs-dist/wasm/openjpeg.wasm")) + path.sep).href });
const document = await loading.promise;
try {
  const page = await document.getPage(1), viewport = page.getViewport({ scale: 1 });
  const canvas = installed("@napi-rs/canvas").createCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  assert.ok(canvas.toBuffer("image/png").length > 0);
} finally { await loading.destroy(); }
assert.throws(() => installed.resolve("electron"), /Cannot find module/);
const terminal = installed("node-pty").spawn("/bin/sh", ["-c", "exit 0"], { cwd: workspace });
await new Promise(resolve => terminal.onExit(event => { assert.equal(event.exitCode, 0); resolve(); }));

async function command(method, params) {
  const args = [cli, method];
  if (params) {
    const file = path.join(temporary, `params-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(params), { mode: 0o600 });
    args.push("--params-file", file);
  }
  const child = spawn(process.execPath, args, { env, cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  assert.equal((await once(child, "exit"))[0], 0, errors);
  return output.trim();
}
assert.match(await command("--help"), /PwrAgent Outpost/);
assert.match(await command("--version"), /^pwragent \d+\.\d+\.\d+/);
const daemon = spawn(process.execPath, [cli, "serve", "--workspace", workspace, "--codex-home", home, "--codex-bin", fixture],
  { env, cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
const done = once(daemon, "exit");
let errors = "";
daemon.stderr.on("data", chunk => { errors += chunk; });
try {
  await new Promise((resolve, reject) => {
    daemon.stdout.on("data", chunk => { if (String(chunk).includes('"ready":true')) resolve(); });
    done.then(([code]) => reject(new Error(`Outpost exited before ready (${code}): ${errors}`)));
  });
  const state = path.join(env.PWRAGENT_HOME, "profiles/t/state/headless");
  assert.doesNotMatch(errors, /Unhandled electron-log error|can't determine the app name/);
  assert.equal(fs.statSync(path.join(state, "owner.lock")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(state, "owner-lock.db")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(state, "rpc.sock")).mode & 0o777, 0o600);
  const thread = JSON.parse(await command("start-thread", { backend: "codex", cwd: workspace, executionMode: "auto" }));
  const health = JSON.parse(await command("federation-status"));
  const request = { ...thread, input: [{ type: "text", text: "Installed owner smoke" }], delivery: "new_turn" };
  const createdAt = Date.now();
  const submission = { request, clientRequest: { version: 1, id: randomUUID(), createdAt } };
  submission.clientRequest.payloadHash = createHash("sha256").update(owner.canonicalDurableTurnRequest(health.instanceId, submission)).digest("hex");
  const receipt = JSON.parse(await command("submit", submission));
  assert.equal(receipt.id, submission.clientRequest.id);
  assert.ok(receipt.queueEntryId);
  assert.deepEqual(JSON.parse(await command("submit", submission)).queueEntryId, receipt.queueEntryId);
  const retained = JSON.parse(await command("receipt", { ...thread, id: receipt.id }));
  assert.equal(retained.queueEntryId, receipt.queueEntryId);
  assert.equal(JSON.parse(await command("show", thread)).threadId, thread.threadId);
  await command("list");
  const launch = fs.readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse).find(row => row.startup)?.startup;
  assert.ok(launch.includes('approval_policy="never"'));
  assert.ok(launch.includes('default_permissions="pwragent-outpost-read-only"'));
  assert.ok(launch.includes("permissions.pwragent-outpost-workspace-write.network.enabled=false"));
  assert.ok(!launch.some((value) => value.startsWith("sandbox_mode=")));
  const preflight = fs.readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse).find(row => row.sandbox)?.sandbox;
  assert.deepEqual(preflight.slice(preflight.indexOf("-P"), preflight.indexOf("-P") + 2), ["-P", "pwragent-outpost-workspace-write"]);
} finally {
  daemon.kill("SIGTERM");
  assert.equal((await done)[0], 0, errors);
}
console.log("Installed Node owner: native modules, sandbox preflight, private lock, durable acceptance and CLI reads passed.");
