import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const branchBase = "b398c6f2da8c9aa5aadd10c2371dd323bf654353";
const core = "apps/desktop/src/main/messaging/core/";
const controller = "messaging-controller.ts";
const handoff = "messaging-handoff-workflow.ts";
// After the extraction lands, verify its introducing commit even if the
// controller changes again. Use --worktree to verify an in-progress diff.
const extraction = process.argv.includes("--worktree") ? undefined : execFileSync("git", [
  "log", "--first-parent", "--diff-filter=A", "-1", "--format=%H", "HEAD", "--", core + handoff,
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
const workflow = source(handoff, extraction);
const before = members(original, "MessagingController");
const facade = members(current, "MessagingController");
const owner = members(workflow, "MessagingHandoffWorkflow");

const originalPorts = {
  backend: "this.options.backend",
  store: "this.options.store",
  queryPool: "this.browse.queryPool",
  deliverAndStoreStatusSubmode: "this.bindingService.deliverAndStoreStatusSubmode",
  updateBindingAfterHandoff: "this.bindingService.updateBindingAfterHandoff",
  renderBindingStatus: "this.bindingService.renderBindingStatus",
};
const moved = new Set();
for (const [name, node] of owner) {
  if (name === "constructor") continue;
  const restored = node.getText(workflow)
    .replaceAll(/this\.context\.(\w+)/g, (_, port) => originalPorts[port] ?? `this.${port}`)
    .replace(/^private /, "");
  assert.equal(restored, before.get(name)?.getText(original).replace(/^private /, ""), name);
  assert.ok(!facade.has(name), name);
  moved.add(name);
}
assert.equal(moved.size, 10);

function declarations(file) {
  return new Map(file.statements
    .filter(node => node.name || ts.isVariableStatement(node))
    .map(node => [node.name?.getText(file) ?? node.declarationList.declarations[0].name.getText(file), node.getText(file)]));
}
const originalDeclarations = declarations(original);
const workflowDeclarations = declarations(workflow);
for (const name of ["validateHandoffRequest", "formatHandoffDirection", "handoffSuccessText", "ACTIVE_TURN_HANDOFF_ERROR"]) {
  assert.equal(workflowDeclarations.get(name), originalDeclarations.get(name), name);
  assert.ok(!declarations(current).has(name), name);
}

const ctor = facade.get("constructor");
const read = ctor.body.statements.find(node => node.getText(current).startsWith("const readBrowseQueryPool ="));
const wiring = ctor.body.statements.find(node => node.getText(current).startsWith("this.handoff = new MessagingHandoffWorkflow("));
assert.equal(read?.getText(current), "const readBrowseQueryPool = () => this.browse.queryPool;");
assert.ok(wiring);
const args = wiring.expression.right.arguments;
assert.equal(args.length, 1, "handoff constructor arguments");
assert.ok(ts.isObjectLiteralExpression(args[0]), "handoff context");
assert.deepEqual(args[0].properties.map(node => node.getText(current)), [
  "get backend() { return readBackend(); }",
  "get store() { return readStore(); }",
  "get queryPool() { return readBrowseQueryPool(); }",
  "get capabilityProfile() { return readCapabilityProfile(); }",
  "now: () => this.now()",
  "newIntentId: (...args) => this.newIntentId(...args)",
  "getActiveTurn: (...args) => this.getActiveTurn(...args)",
  "readBoundWorkspaceContext: (...args) => this.readBoundWorkspaceContext(...args)",
  "readBoundNavigationThread: (...args) => this.readBoundNavigationThread(...args)",
  "deliver: (...args) => this.deliver(...args)",
  "deliverAndStoreStatusSubmode: (...args) => this.bindingService.deliverAndStoreStatusSubmode(...args)",
  "updateBindingAfterHandoff: (...args) => this.bindingService.updateBindingAfterHandoff(...args)",
  "renderBindingStatus: (...args) => this.bindingService.renderBindingStatus(...args)",
], "handoff context wiring");

for (const [name, node] of before) {
  if (moved.has(name)) continue;
  let actual = facade.get(name)?.getText(current);
  if (name === "constructor") {
    actual = actual.replace("\n    " + read.getText(current), "").replace("\n    " + wiring.getText(current), "");
  }
  if (name === "callbackHost") actual = actual.replaceAll("this.handoff.", "this.");
  assert.equal(actual, node.getText(original), name);
}

console.log(JSON.stringify({
  baseline, extraction: extraction ?? "worktree", moved: moved.size,
  before: original.text.trimEnd().split("\n").length,
  after: current.text.trimEnd().split("\n").length,
}));
