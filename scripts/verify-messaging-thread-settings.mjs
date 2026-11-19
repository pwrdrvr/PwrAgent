import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const branchBase = "8090ac1c5d67490bc291984be8b8109833b13b80";
const core = "apps/desktop/src/main/messaging/core/";
const controller = "messaging-controller.ts";
const settings = "messaging-thread-settings.ts";
// After the extraction lands, verify its introducing commit even if the
// controller changes again. Use --worktree to verify an in-progress diff.
const extraction = process.argv.includes("--worktree") ? undefined : execFileSync("git", [
  "log", "--first-parent", "--diff-filter=A", "-1", "--format=%H", "HEAD", "--", core + settings,
], { encoding: "utf8" }).trim() || undefined;
const baseline = extraction
  ? execFileSync("git", ["rev-parse", extraction + "^1"], { encoding: "utf8" }).trim()
  : branchBase;

function source(name, revision) {
  const path = core + name;
  const text = revision ? execFileSync("git", ["show", revision + ":" + path], { encoding: "utf8" }) : readFileSync(path, "utf8");
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  assert.deepEqual(file.parseDiagnostics.map(diagnostic => diagnostic.messageText), [], name);
  return file;
}

function members(file, className) {
  const owner = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
  assert.ok(owner, className);
  return new Map(owner.members.map(node => [node.name?.getText(file) ?? "constructor", node]));
}

const original = source(controller, baseline);
const current = source(controller, extraction);
const workflow = source(settings, extraction);
const before = members(original, "MessagingController");
const facade = members(current, "MessagingController");
const owner = members(workflow, "MessagingThreadSettings");

const moved = new Set();
for (const [name, node] of owner) {
  if (name === "constructor") continue;
  const restored = node.getText(workflow)
    .replaceAll(/this\.context\.(backend|store)\b/g, "this.options.$1")
    .replaceAll("this.context.", "this.")
    .replace(/^private /, "");
  assert.equal(restored, before.get(name)?.getText(original).replace(/^private /, ""), name);
  assert.ok(!facade.has(name), name);
  moved.add(name);
}
assert.equal(moved.size, 18);

for (const name of ["resolveExecutionModeForBinding", "executionModeForBinding"]) {
  const get = file => file.statements.find(node => node.name?.text === name)?.getText(file);
  assert.ok(get(original), name);
  assert.equal(get(workflow), get(original), name);
  assert.equal(get(current), undefined, name);
}

const ctor = facade.get("constructor");
const statements = ctor.body.statements.map(node => node.getText(current));
const reads = [
  "const readSettingsAccess = () => this.accessControl;",
  "const readSettingsBindings = () => this.bindingService;",
  "const readSettingsInbound = () => this.inboundTurns;",
];
for (const read of reads) assert.equal(statements.filter(s => s === read).length, 1, read);
const wiring = ctor.body.statements.find(node => node.getText(current).startsWith("this.threadSettings = new MessagingThreadSettings("));
assert.ok(wiring);
const args = wiring.expression.right.arguments;
assert.equal(args.length, 1, "settings constructor arguments");
assert.ok(ts.isObjectLiteralExpression(args[0]), "settings context");
assert.deepEqual(args[0].properties.map(node => node.getText(current)), [
  "get backend() { return readBackend(); }",
  "get store() { return readStore(); }",
  "get accessControl() { return readSettingsAccess(); }",
  "get bindingService() { return readSettingsBindings(); }",
  "get inboundTurns() { return readSettingsInbound(); }",
  "get capabilityProfile() { return readCapabilityProfile(); }",
  "get streamingResponsesDefault() { return readStreamingDefault(); }",
  "now: () => this.now()",
  "newIntentId: (...args) => this.newIntentId(...args)",
  "deliver: (...args) => this.deliver(...args)",
  "deliverInvalidStatusSelection: (...args) => this.deliverInvalidStatusSelection(...args)",
  "getBackendSummary: (...args) => this.getBackendSummary(...args)",
  "readBoundThreadConfiguration: (...args) => this.readBoundThreadConfiguration(...args)",
  "storePendingIntent: (...args) => this.storePendingIntent(...args)",
], "settings context wiring");

// The callback handlers already route permission selection to setBindingPermissionsMode.
assert.ok(!facade.has("togglePermissionsMode") && !owner.has("togglePermissionsMode"));
for (const [name, node] of before) {
  if (moved.has(name) || name === "togglePermissionsMode") continue;
  let actual = facade.get(name)?.getText(current);
  if (name === "constructor") {
    for (const statement of [...reads, wiring.getText(current)]) actual = actual.replace("\n    " + statement, "");
  }
  if (["inboundHost", "newThreadHost", "callbackHost"].includes(name)) {
    actual = actual.replaceAll("this.threadSettings.", "this.");
  }
  assert.equal(actual, node.getText(original), name);
}

console.log(JSON.stringify({
  baseline, extraction: extraction ?? "worktree", moved: moved.size,
  before: original.text.trimEnd().split("\n").length,
  after: current.text.trimEnd().split("\n").length,
}));
