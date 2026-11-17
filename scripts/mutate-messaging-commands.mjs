import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const baseline = "337cf083a1894aab6e6e8b5328c55b5a97411cde";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const controller = `${core}messaging-controller.ts`;
const commands = `${core}messaging-command-handlers.ts`;
const helpers = `${core}messaging-command-helpers.ts`;
const originals = new Map([controller, commands, helpers].map(file => [file, readFileSync(file, "utf8")]));
const directory = ".local/pwr-149-commands/mutations";
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(name => `${tests}fixtures/${name}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = protectedFiles.map(hash);
mkdirSync(directory, { recursive: true });
const ownerTests = ["messaging-command-handlers.property.test.ts"];
const observable = ["messaging-command-observable.property.test.ts"];
const mutations = [
  ["permission", commands, "!(await this.context.host().requirePermission(event, permission, `command:${verb}`))", "false && !(await this.context.host().requirePermission(event, permission, `command:${verb}`))", ownerTests],
  ["remote-scope-exemption", commands, 'verb !== "detach" &&', "true &&", ownerTests],
  ["dispatch", commands, "await this.context.host().detachBinding(event);", "await this.context.host().presentStatus(event);", ownerTests],
  ["workflow-await", commands, "await this.context.host().presentStatus(event);", "void this.context.host().presentStatus(event);", ownerTests],
  ["backend-receiver", commands, "this.context.backend.listScheduledThreadActions?.bind(\n      this.context.backend,", "this.context.backend.listScheduledThreadActions?.bind(\n      {},", ownerTests],
  ["getter-boundary", commands, "    try {\n      if (operation", "    const outsideCatch = this.context.backend.cancelScheduledThreadAction;\n    void outsideCatch;\n    try {\n      if (operation", ownerTests],
  ["schedule-payload", commands, 'origin: "messaging",\n      scheduledFor: parsed.scheduledFor,\n      displayText: parsed.text,', 'origin: "messaging",\n      scheduledFor: parsed.scheduledFor,\n      displayText: "Lost message",', observable],
  ["schedule-failure", helpers, 'return action.status === "failed"', "return false", ["messaging-command-helpers.property.test.ts", ...observable]],
  ["facade-caller", controller, "await this.commandHandlers.handleCommand(event);", "await this.commandHandlers.presentHelp(event);", observable],
  ["host-port", controller, "  private commandHost(): MessagingCommandHost {\n    return this.commandHostPorts ??= {\n      requirePermission: (...args) => this.requirePermission(...args),", "  private commandHost(): MessagingCommandHost {\n    return this.commandHostPorts ??= {\n      requirePermission: async () => false,", observable],
  ["store-port", controller, "      get store() { return readStore(); },\n      get backend() { return readBackend(); },", "      store: readStore(),\n      get backend() { return readBackend(); },", observable],
];
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
function restore() {
  for (const [file, text] of originals) writeFileSync(file, text);
  for (const [index, file] of protectedFiles.entries()) if (hash(file) !== hashes[index]) throw new Error(`Protected fixture changed: ${file}`);
}
function run(name, selected, expectPass) {
  const result = spawnSync("pnpm", ["test", ...selected.map(file => tests + file)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(`${directory}/${name}.log`, log);
  const assertions = /AssertionError|expected .* to |Property failed after/.test(log);
  const invalid = /SyntaxError|ReferenceError|Failed to load|Cannot find module|Cannot read properties|is not a function|invalid signature|timed out/.test(log);
  const passed = expectPass ? result.status === 0 : result.status !== 0 && assertions && !invalid;
  const evidence = { name, status: result.status, assertions, invalid, passed };
  console.log(JSON.stringify(evidence));
  return evidence;
}
const results = [];
try {
  if (process.argv.includes("--baseline")) {
    writeFileSync(controller, execFileSync("git", ["show", `${baseline}:${controller}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
    results.push(run("pinned-main-observable", observable, true));
  } else {
    results.push(run("extracted-production", [...ownerTests, ...observable, "messaging-command-helpers.property.test.ts"], true));
    for (const [name, file, before, after, selected] of mutations) {
      if (only && !name.includes(only)) continue;
      const text = originals.get(file);
      if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Non-unique mutation anchor: ${name}`);
      writeFileSync(file, text.replace(before, after));
      try { results.push(run(name, selected, false)); } finally { restore(); }
    }
  }
} finally { restore(); }
writeFileSync(`${directory}/results${process.argv.includes("--baseline") ? "-baseline" : ""}.json`, `${JSON.stringify(results, null, 2)}\n`);
if (results.some(result => !result.passed)) process.exitCode = 1;
