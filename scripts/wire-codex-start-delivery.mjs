import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// One-time AST rewrite of the two existing delivery scopes. The original
// statements keep their order; only an ownership receipt and finally disposal
// surround them. Observer/event-hub extraction is a separate phase.
const file = "apps/desktop/src/main/app-server/backend-registry.ts";
const source = readFileSync(file, "utf8");
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const registry = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "DesktopBackendRegistry");
const subscriber = registry.members.find(node => node.name?.getText(ast) === "subscribeClient");
const emit = registry.members.find(node => node.name?.getText(ast) === "emit");
assert.ok(subscriber && emit);
assert.ok(!emit.body.getText(ast).includes("ownedStartDelivery"), "Delivery scopes are already wired");
let callback;
function find(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "client.onNotification") callback = node.arguments[0];
  ts.forEachChild(node, find);
}
find(subscriber);
assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
const indent = text => text.split("\n").map(line => line ? "  " + line : line).join("\n");
const terminalNote = (backend, notification, spacing) => `${spacing}if (${backend} === "codex" && (${notification}.method === "turn/completed"\n${spacing}  || ${notification}.method === "turn/failed" || ${notification}.method === "turn/cancelled")) {\n${spacing}  this.context.turnState.observeTurnTerminal(${notification}.params.threadId, turnIdFromTerminalNotification(${notification}));\n${spacing}}`;
let raw = source.slice(callback.body.getStart(ast) + 1, callback.body.getEnd() - 1).trimEnd();
const calls = [];
function findEmit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "this.emit") calls.push(node);
  ts.forEachChild(node, findEmit);
}
findEmit(callback.body);
assert.equal(calls.length, 1);
const call = calls[0];
const insertion = call.getEnd() - 1 - (callback.body.getStart(ast) + 1);
raw = raw.slice(0, insertion) + ", undefined, codexStartDelivery" + raw.slice(insertion);
const callbackBody = `{\n        const codexStartDelivery = backend === "codex" && notification.method === "turn/started"\n          ? this.context.turnState.beginStartDelivery(notification.params.threadId, turnIdFromStartedNotification(notification))\n          : undefined;\n${terminalNote("backend", "notification", "        ")}\n        try {${indent(raw)}\n        } finally {\n          if (codexStartDelivery) this.context.turnState.endStartDelivery(codexStartDelivery);\n        }\n      }`;
let emitted = source.slice(emit.body.getStart(ast) + 1, emit.body.getEnd() - 1).trimEnd();
assert.equal(emitted.split("return emitted;").length, 2);
emitted = emitted.replace("return emitted;", "return await emitted;");
const emitBody = `{\n    const notification = event.notification;\n    const ownedStartDelivery = !codexStartDelivery && event.backend === "codex" && notification.method === "turn/started"\n      ? this.context.turnState.beginStartDelivery(notification.params.threadId, turnIdFromStartedNotification(notification))\n      : undefined;\n    codexStartDelivery ??= ownedStartDelivery;\n${terminalNote("event.backend", "notification", "    ")}\n    try {${indent(emitted)}\n    } finally {\n      if (ownedStartDelivery) this.context.turnState.endStartDelivery(ownedStartDelivery);\n    }\n  }`;
let next = source;
for (const [body, replacement] of [[callback.body, callbackBody], [emit.body, emitBody]].sort((left, right) => right[0].getStart(ast) - left[0].getStart(ast))) {
  next = next.slice(0, body.getStart(ast)) + replacement + next.slice(body.getEnd());
}
writeFileSync(file, next);
console.log("Wrapped the provider listener and synthetic emit scopes; original statement order retained.");
