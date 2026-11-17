import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const baseline = "55b5bff62dbcf3250a253f1a2026ba61a110b1d3";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const controller = `${core}messaging-controller.ts`;
const callbacks = `${core}messaging-callback-handlers.ts`;
const helpers = `${core}messaging-callback-helpers.ts`;
const originals = new Map([controller, callbacks, helpers].map(file => [file, readFileSync(file, "utf8")]));
const directory = ".local/pwr-149-callbacks/mutations";
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(name => `${tests}fixtures/${name}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = protectedFiles.map(hash);
mkdirSync(directory, { recursive: true });
const owner = ["messaging-callback-handlers.property.test.ts"];
const observable = ["messaging-callback-observable.property.test.ts"];
const pure = ["messaging-callback-helpers.property.test.ts"];
const constructor = "constructor(private readonly context: MessagingCallbackContext) {}";
const submit = "        const decision = await this.context.host().submitApprovalAction(\n          pendingIntent.intent,\n          action.id,\n        );";
const mutations = [
  ["status-permission", callbacks, [["!(await this.context.host().requirePermission(event, requiredPermission, actionId))", "false && !(await this.context.host().requirePermission(event, requiredPermission, actionId))"]], owner],
  ["detach-scope", callbacks, [['if (actionId === "status:detach") {', 'if (false && actionId === "status:detach") {']], owner],
  ["refresh-order", callbacks, [["await this.context.host().clearActiveBindingSubmodeIntent(event, binding);\n      await this.context.host().renderBindingStatus(binding, event);", "await this.context.host().renderBindingStatus(binding, event);\n      await this.context.host().clearActiveBindingSubmodeIntent(event, binding);"]], owner, "status"],
  ["stale-proposal", callbacks, [["return clicked && newest.surface && isSameMessagingSurface(clicked, newest.surface)\n        ? newest : undefined;", "return newest;"]], observable],
  ["submission-await", callbacks, [[submit, "        const decision = undefined;\n        void this.context.host().submitApprovalAction(pendingIntent.intent, action.id);"]], observable],
  ["retirement-order", callbacks, [[submit, "        await this.context.store.deletePendingIntent(pendingIntent.id);\n" + submit], ["        await this.context.store.deletePendingIntent(pendingIntent.id);\n        await this.context.host().resumeBindingForPendingIntent(", "        await this.context.host().resumeBindingForPendingIntent("]], observable],
  ["stale-notice-boundary", callbacks, [["      } catch (error) {\n        this.context.logger.debug?.(\n          \"messaging permissions-queue stale-cancel notice failed\",", "      } catch (error) {\n        throw error;\n        this.context.logger.debug?.(\n          \"messaging permissions-queue stale-cancel notice failed\","]], owner],
  ["store-snapshot", callbacks, [[constructor, "constructor(private readonly context: MessagingCallbackContext) { const store = context.store; this.context = { ...context, store }; }"]], owner],
  ["host-snapshot", callbacks, [[constructor, "constructor(private readonly context: MessagingCallbackContext) { const host = context.host(); this.context = { ...context, host: () => host }; }"]], owner],
  ["surface-provider", helpers, [["&& left.channel === right.channel", "&& true"]], pure],
  ["private-option-bound", helpers, [["/^[0-2]$/", "/^[0-3]$/"]], pure],
  ["risk-owner", helpers, [["? { federationInstanceId: value.federationInstanceId }", '? { federationInstanceId: "wrong-owner" }']], pure],
  ["facade-caller", controller, [["await this.callbackHandlers.handleCallback(event);", "await this.commandHandlers.presentHelp(event);"]], observable],
  ["delivery-port", controller, [["      deliver: (...args) => this.deliver(...args),", '      deliver: async () => ({ outcome: "presented", channel: "telegram", deliveredAt: 0 }),']], observable, "callbackHost"],
  ["overlay-port", controller, [["      get store() { return readStore(); },", "      store: readStore(),"]], observable, "callback-construction"],
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
function changedSource(name, file, edits, section) {
  const source = originals.get(file);
  const start = section === "status" ? source.indexOf("  async handleStatusCallback(")
    : section === "callbackHost" ? source.indexOf("  private callbackHost():")
      : section === "callback-construction" ? source.indexOf("    this.callbackHandlers = new MessagingCallbackHandlers({") : 0;
  const end = section === "status" ? source.indexOf("  private async handleFullAccessRiskCallback(", start)
    : section === "callbackHost" ? source.indexOf("  private backendEventHost():", start)
      : section === "callback-construction" ? source.indexOf("    this.authorizedActorIds =", start) : source.length;
  if (start < 0 || end < 0) throw new Error(`Missing mutation section: ${name}`);
  let text = source.slice(start, end);
  for (const [before, after] of edits) {
    if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Non-unique mutation anchor: ${name}`);
    text = text.replace(before, after);
  }
  return source.slice(0, start) + text + source.slice(end);
}
if (process.argv.includes("--check")) {
  for (const [name, file, edits, , section] of mutations) changedSource(name, file, edits, section);
  console.log(JSON.stringify({ anchorsVerified: mutations.length }));
  process.exit(0);
}
const results = [];
try {
  if (process.argv.includes("--baseline")) {
    writeFileSync(controller, execFileSync("git", ["show", `${baseline}:${controller}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
    results.push(run("pinned-main-observable", observable, true));
  } else {
    results.push(run("extracted-production", [...owner, ...observable, ...pure], true));
    for (const [name, file, edits, selected, section] of mutations) {
      if (only && !name.includes(only)) continue;
      writeFileSync(file, changedSource(name, file, edits, section));
      try { results.push(run(name, selected, false)); } finally { restore(); }
    }
  }
} finally { restore(); }
writeFileSync(`${directory}/results${process.argv.includes("--baseline") ? "-baseline" : ""}.json`, `${JSON.stringify(results, null, 2)}\n`);
if (results.some(result => !result.passed)) process.exitCode = 1;
