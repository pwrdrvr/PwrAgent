import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import ts from "typescript";

// Compare the merge commit to its parent so unrelated main changes made
// before and after the extraction stay outside this verification.
const baseline = "96142fa3d8af8edc70433aa496c01fbf3590ed2e";
const extraction = "cdf4b930c350d3513e28b294cb00abd184a94d04";
const core = "apps/desktop/src/main/messaging/core/";
const controller = "messaging-controller.ts";

function source(name, original = false) {
  const path = core + name;
  const text = execFileSync("git", ["show", (original ? baseline : extraction) + ":" + path], { encoding: "utf8" });
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  assert.deepEqual(file.parseDiagnostics.map(diagnostic => diagnostic.messageText), [], name);
  return file;
}

function classMembers(file, name) {
  const owner = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
  assert.ok(owner, name);
  return new Map(owner.members.map(node => [node.name?.getText(file) ?? "constructor", node.getText(file)]));
}

function declarations(file) {
  return new Map(file.statements
    .filter(node => node.name && !ts.isClassDeclaration(node))
    .map(node => [node.name.getText(file), node.getText(file)]));
}

const original = source(controller, true);
const current = source(controller);
const delivery = source("messaging-outbound-delivery.ts");
const before = classMembers(original, "MessagingController");
const facade = classMembers(current, "MessagingController");
const owner = classMembers(delivery, "MessagingOutboundDelivery");
const routed = new Set(["adapter", "deliver"]);
const moved = new Set();
for (const [name, member] of owner) {
  if (name === "constructor") continue;
  const restored = member
    .replace(/^private /, "")
    .replaceAll("this.context.clock", "this.now")
    .replace(/this\.context\.(recordBindingTransition|notifyBindingChanged)/g, "this.bindingService.$1")
    .replaceAll("this.context.", "this.");
  assert.equal(restored, before.get(name)?.replace(/^private /, ""), name);
  if (!routed.has(name)) {
    assert.ok(!facade.has(name), `${name} still exists on the facade`);
  }
  moved.add(name);
}

assert.equal(facade.get("adapter"), `private get adapter(): MessagingAdapter {
    return this.outboundDelivery.adapter;
  }`);
assert.equal(facade.get("deliver"), before.get("deliver").split("    if (binding", 1)[0]
  .replace("private async deliver", "private deliver")
  + "    return this.outboundDelivery.deliver(intent, binding, event, guard);\n  }");
assert.equal(facade.get("backendEventHost").replace("this.outboundDelivery.deliverArtifactForBinding", "this.deliverArtifactForBinding"),
  before.get("backendEventHost"));
assert.equal(owner.get("constructor"), `constructor(
    private readonly options: MessagingOutboundDeliveryOptions,
    private readonly context: MessagingOutboundDeliveryContext,
  ) {
    this.deliveryBudget = options.deliveryBudget;
  }`);

const ctorWiring = `this.outboundDelivery = new MessagingOutboundDelivery(options, {
      get disposed() { return readDisposed(); },
      get capabilityProfile() { return readCapabilityProfile(); },
      get logger() { return readLogger(); },
      get clock() { return readNow(); },
      now: () => this.now(),
      flushToolUpdatesForBinding: (...args) => this.flushToolUpdatesForBinding(...args),
      markWorkingCardWaiting: (...args) => this.markWorkingCardWaiting(...args),
      desktopActivityLog: () => this.desktopActivityLog(),
      recordBindingTransition: (...args) => this.bindingService.recordBindingTransition(...args),
      notifyBindingChanged: (...args) => this.bindingService.notifyBindingChanged(...args),
    });`;
assert.equal(facade.get("constructor").replace(ctorWiring, "this.deliveryBudget = options.deliveryBudget;"),
  before.get("constructor"), "constructor wiring and read order");

for (const [name, member] of before) {
  if (moved.has(name) || ["backendEventHost", "constructor"].includes(name)) continue;
  assert.equal(facade.get(name), member, name);
}

const originalDeclarations = declarations(original);
const facadeDeclarations = declarations(current);
const deliveryDeclarations = declarations(delivery);
for (const [name, definition] of originalDeclarations) {
  if (deliveryDeclarations.has(name)) {
    assert.equal(deliveryDeclarations.get(name), definition, name);
    assert.ok(!facadeDeclarations.has(name), `${name} still exists on the facade`);
  } else {
    assert.equal(facadeDeclarations.get(name), definition, name);
  }
}

console.log(JSON.stringify({
  baseline,
  extraction,
  movedMembers: moved.size,
  movedDeclarations: [...deliveryDeclarations.keys()].filter(name => originalDeclarations.has(name)).length,
  originalControllerLines: original.text.trimEnd().split("\n").length,
  controllerLines: current.text.trimEnd().split("\n").length,
}));
