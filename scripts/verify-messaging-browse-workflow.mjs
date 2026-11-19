import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const branchBase = "cdf4b930c350d3513e28b294cb00abd184a94d04";
const core = "apps/desktop/src/main/messaging/core/";
const controller = "messaging-controller.ts";
const browse = "messaging-browse-workflow.ts";
// After the extraction lands, verify its introducing commit even if the
// controller changes again. Use --worktree to verify an in-progress diff.
const extraction = process.argv.includes("--worktree") ? undefined : execFileSync("git", [
  "log", "--first-parent", "--diff-filter=A", "-1", "--format=%H", "HEAD", "--", core + browse,
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
const workflow = source(browse, extraction);
const before = members(original, "MessagingController");
const facade = members(current, "MessagingController");
const owner = members(workflow, "MessagingBrowseWorkflow");

const originalPorts = {
  backend: "this.options.backend",
  store: "this.options.store",
  actorHasPermission: "this.accessControl.actorHasPermission",
  canResumeFullAccessThreads: "this.accessControl.canResumeFullAccessThreads",
  resolveNewThreadBackendForSession: "this.newThreadWorkflow.resolveNewThreadBackendForSession",
  loadDefaultAgentBackendSummaries: "this.inboundTurns.loadDefaultAgentBackendSummaries",
  clearPendingNewThreadPrompt: "this.inboundTurns.clearPendingNewThreadPrompt",
  clearPendingFullAccessNewThreadPrompt: "this.inboundTurns.pendingFullAccessNewThreadPrompts.delete",
};
const moved = new Set();
for (const [name, node] of owner) {
  if (["constructor", "cancelProgressiveBrowse", "dispose"].includes(name)) continue;
  const originalName = name === "queryPool" ? "browseQueryPool" : name;
  const restored = node.getText(workflow)
    .replaceAll(/this\.context\.(\w+)/g, (_, port) => originalPorts[port] ?? `this.${port}`)
    .replaceAll("queryPool", "browseQueryPool")
    .replace(/^private /, "");
  assert.equal(restored, before.get(originalName)?.getText(original).replace(/^private /, ""), name);
  assert.ok(!facade.has(originalName), originalName);
  moved.add(originalName);
}
assert.equal(moved.size, 10);

const ctor = facade.get("constructor");
const wiring = ctor.body.statements.find(node => node.getText(current).startsWith("this.browse = new MessagingBrowseWorkflow("));
assert.ok(wiring);
const args = wiring.expression.right.arguments;
assert.equal(args.length, 1, "browse constructor arguments");
assert.ok(ts.isObjectLiteralExpression(args[0]), "browse context");
// Compare every port before reversing the extraction's constructor block.
// The exact arrow bodies preserve the receiver, argument order, and late reads.
assert.deepEqual(args[0].properties.map(node => node.getText(current)), [
  "get backend() { return readBackend(); }",
  "get store() { return readStore(); }",
  "get capabilityProfile() { return readCapabilityProfile(); }",
  "get pendingIntentTtlMs() { return readPendingIntentTtl(); }",
  "get disposed() { return readDisposed(); }",
  "get logger() { return readLogger(); }",
  "now: () => this.now()",
  "deliver: (...args) => this.deliver(...args)",
  "storePendingIntent: (...args) => this.storePendingIntent(...args)",
  "newIntentId: (...args) => this.newIntentId(...args)",
  "resolveNewThreadBackendForSession: (...args) => this.newThreadWorkflow.resolveNewThreadBackendForSession(...args)",
  "loadDefaultAgentBackendSummaries: () => this.inboundTurns.loadDefaultAgentBackendSummaries()",
  "actorHasPermission: (...args) => this.accessControl.actorHasPermission(...args)",
  "canResumeFullAccessThreads: () => this.accessControl.canResumeFullAccessThreads()",
  "deliverDefaultAgentCommandError: (...args) => this.deliverDefaultAgentCommandError(...args)",
  "clearPendingNewThreadPrompt: (sessionId) => this.inboundTurns.clearPendingNewThreadPrompt(sessionId)",
  "clearPendingFullAccessNewThreadPrompt: (sessionId) => { this.inboundTurns.pendingFullAccessNewThreadPrompts.delete(sessionId); }",
], "browse context wiring");
const cancels = owner.get("cancelProgressiveBrowse").body.getText(workflow).slice(6, -4);
const dispose = owner.get("dispose").body.getText(workflow).slice(6, -4);
for (const [name, node] of before) {
  if (moved.has(name)) continue;
  let actual = facade.get(name)?.getText(current);
  if (name === "constructor") actual = actual.replace("\n    " + wiring.getText(current), "");
  if (name === "handleInboundEvent") actual = actual.replace("this.browse.cancelProgressiveBrowse(event.channel);", cancels.replace("(channel)", "(event.channel)"));
  if (name === "dispose") actual = actual.replace("this.browse.dispose();", dispose.replace("this.queryPool", "this.browseQueryPool"));
  if (["newThreadHost", "commandHost", "callbackHost", "presentHandoffProjectPicker"].includes(name)) {
    actual = actual.replaceAll("this.browse.", "this.").replaceAll("this.queryPool", "this.browseQueryPool");
  }
  assert.equal(actual, node.getText(original), name);
}

console.log(JSON.stringify({
  baseline, extraction: extraction ?? "worktree", moved: moved.size,
  before: original.text.trimEnd().split("\n").length,
  after: current.text.trimEnd().split("\n").length,
}));
