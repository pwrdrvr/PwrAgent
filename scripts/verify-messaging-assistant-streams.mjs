import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import ts from "typescript";

const baseline = "fec40d7d78e6746c6283345b87fbfb63ab29c6ee";
const core = "apps/desktop/src/main/messaging/core/";
const controller = "messaging-controller.ts";
const streamFile = "messaging-assistant-streams.ts";
const router = "messaging-backend-event-router.ts";
const helpers = "messaging-backend-event-helpers.ts";

function source(file, original = false) {
  const path = core + file;
  const text = original ? execFileSync("git", ["show", baseline + ":" + path], { encoding: "utf8" }) : readFileSync(path, "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function members(file, className) {
  const owner = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
  assert.ok(owner, className);
  return new Map(owner.members.filter(node => node.name).map(node => [node.name.getText(file), node]));
}

function declaration(file, name) {
  const node = file.statements.find(node => node.name?.getText(file) === name);
  assert.ok(node, name);
  return node.getText(file);
}

const current = source(controller);
const original = source(controller, true);
const oldMembers = members(original, "MessagingController");
const facade = members(current, "MessagingController");
const ownerFile = source(streamFile);
const owner = members(ownerFile, "MessagingAssistantStreams");
const additional = new Set(["dispose", "discardAssistantStreamItemForEvent"]);
const restoreHost = text => text.replaceAll("this.context.host.", "this.").replaceAll("this.context.", "this.");
let moved = 0;
for (const [name, node] of owner) {
  if (additional.has(name)) continue;
  assert.equal(restoreHost(node.getText(ownerFile)).replace(/^private /, ""),
    oldMembers.get(name)?.getText(original).replace(/^private /, ""), name);
  assert.equal(facade.has(name), false, name + " must have one owner");
  moved++;
}

const beforeDispose = oldMembers.get("dispose").getText(original);
const disposal = owner.get("dispose").body.getText(ownerFile).slice(2, -4);
assert.equal(facade.get("dispose").getText(current).replace("    this.assistantStreams.dispose();", disposal),
  beforeDispose, "disposal order");
const oldRouter = source(router, true);
const newRouter = source(router);
const discard = restoreHost(owner.get("discardAssistantStreamItemForEvent").body.getText(ownerFile))
  .slice(2, -4).split("\n").map(line => "    " + line).join("\n")
  .replace(/this\.(assistantStreamBufferKeysForEvent|assistantStreamBuffers|assistantStreamDeliveryQueues|assistantStreamCancellationSignals|turnProseKey)/g, "this.context.host().$1");
assert.equal(newRouter.text.replace(
  "        this.context.host().discardAssistantStreamItemForEvent(event, binding, itemId);", discard),
oldRouter.text, "router control flow and awaits");

for (const name of ["assistantStreamKeysForBackendEvent", "assistantStreamFilterForBackendEvent"]) {
  assert.equal(declaration(ownerFile, name), declaration(original, name), name);
}
assert.equal(declaration(source(helpers), "messagingSurfaceKey"), "export " + declaration(original, "messagingSurfaceKey"));
assert.equal(declaration(ownerFile, "AssistantStreamBuffer"), declaration(source(helpers, true), "AssistantStreamBuffer").replace(/^export /, ""));

const adjusted = new Set(["dispose", "agentToolHost", "backendEventHost"]);
for (const [name, node] of oldMembers) {
  if (owner.has(name) || adjusted.has(name)) continue;
  assert.equal(facade.get(name)?.getText(current), node.getText(original), name);
}

console.log(JSON.stringify({
  baseline, moved, checkedRouter: true, checkedDisposal: true,
  originalControllerLines: original.text.trimEnd().split("\n").length,
  controllerLines: current.text.trimEnd().split("\n").length,
}));
