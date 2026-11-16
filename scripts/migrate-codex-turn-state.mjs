import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// Mechanical phase 4 call-site migration. Activity semantics and the handful
// of multi-step handoffs are reviewed separately in the production diff.
const directory = "apps/desktop/src/main/app-server";
const rules = {
  activeTurnKeys: { add: "registerTurn", delete: "unregisterTurn", has: "hasRegisteredTurn", onDelete: "onTurnUnregistered", size: "registeredTurnCount", iterate: "registeredTurnKeys()" },
  activeCodexTurnModes: { set: "acceptExecution", get: "executionMode", has: "ownsExecution", delete: "forgetExecution", keys: "executionKeys", entries: "executionEntries", size: "executionCount", iterate: "executionEntries()" },
  activeCodexTurnCollaborationModes: { set: "setCollaboration", get: "collaborationMode", delete: "forgetCollaboration" },
  activeCodexReviewTurnKeys: { add: "markReview", has: "isReview", delete: "forgetReview", iterate: "reviewKeys()" },
  activeCodexReviewInterruptTurnIds: { set: "setReviewInterrupt", get: "reviewInterrupt", delete: "forgetReviewInterrupt", entries: "reviewInterruptEntries" },
  reservedCodexStartThreadIds: { has: "hasStartReservation", delete: "releaseStart", size: "startReservationCount", iterate: "startReservationThreadIds()" },
  codexRetryableOperations: { set: "assignRetry", get: "retryOperation", has: "hasRetry", delete: "forgetRetry", values: "retryOperations", iterate: "retryEntries()" },
  backendActiveCodexThreadIds: { has: "providerActive", size: "providerActiveCount", iterate: "providerActiveThreadIds()" },
  startingTurnOrigins: { add: "addStartingOrigin", delete: "removeStartingOrigin", iterate: "startingOrigins()" },
  pendingReviewStarts: { get: "reviewAdmission", values: "reviewAdmissions", set: "setReviewAdmission" },
  activeReviewSubAgents: { get: "liveReviewRecords().get", values: "liveReviewRecords().values", entries: "liveReviewRecords().entries", set: "activateReview", delete: "finishReview", size: "liveReviewRecords().size", iterate: "liveReviewRecords()" },
  managedReviewParentsByChildThread: { get: "reviewChildParent", set: "linkReviewChild", delete: "unlinkReviewChild" },
};
const fields = new Set([...Object.keys(rules), "observedCodexThreadStatuses", "latestCodexThreadStatusObservationSequences", "codexThreadStatusObservationSequence"]);
const changes = [];
for (const name of readdirSync(directory).filter(name => name.endsWith(".ts") && !["backend-registry-wiring.ts", "registry-turn-state.ts", "codex-thread-activity.ts"].includes(name))) {
  const file = `${directory}/${name}`;
  const text = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  const edit = (node, replacement) => edits.push({ start: node.getStart(ast), end: node.getEnd(), replacement });
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "turnState"
      && ["registerTurn", "unregisterTurn", "hasRegisteredTurn", "acceptExecution", "resolveExecution", "registration",
        "executionMode", "ownsExecution", "changeExecution", "forgetExecution", "collaborationMode", "setCollaboration",
        "forgetCollaboration", "markReview", "forgetReview", "isReview", "setReviewInterrupt", "forgetReviewInterrupt", "reviewInterrupt"].includes(node.expression.name.text)) {
      const argument = node.arguments[0];
      if (argument && ts.isCallExpression(argument) && ts.isIdentifier(argument.expression)
        && ["buildActiveTurnKey", "buildActiveTurnModeKey"].includes(argument.expression.text)) {
        const names = argument.expression.text === "buildActiveTurnKey" ? ["backend", "threadId", "turnId"] : ["threadId", "turnId"];
        assert.equal(argument.arguments.length, names.length);
        edit(argument, `{ ${names.map((name, index) => `${name}: ${argument.arguments[index].getText(ast)}`).join(", ")} }`);
        for (const extra of node.arguments.slice(1)) visit(extra);
        return;
      }
    }
    if ((ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isGetAccessorDeclaration(node)) && fields.has(node.name.getText(ast))) {
      // Keep explanatory comments for the manual semantic review.
      if (ts.isGetAccessorDeclaration(node)) edits.push({ start: node.getStart(ast), end: node.getEnd() + (text[node.getEnd()] === "," ? 1 : 0), replacement: "" });
      else edit(node, "");
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression)) {
      const access = node.expression.expression;
      const rule = Object.hasOwn(rules, access.name.text) ? rules[access.name.text] : undefined;
      if (rule && (access.expression.kind === ts.SyntaxKind.ThisKeyword || access.expression.getText(ast) === "this.host()")) {
        const method = node.expression.name.text;
        if (method === "set" && ["pendingReviewStarts", "activeReviewSubAgents"].includes(access.name.text)) {
          edit(node, `this.context.turnState.${rule[method]}(${node.arguments[1].getText(ast)})`);
          return;
        }
        if (method === "add" && access.name.text === "reservedCodexStartThreadIds") {
          // Review every reservation's kind and request identity manually.
          edit(node, `this.context.turnState.reserveStart(${node.arguments.map(arg => arg.getText(ast)).join(", ")}, "turn")`);
          return;
        }
        if (["add", "delete"].includes(method) && access.name.text === "backendActiveCodexThreadIds") {
          edit(node, `this.context.turnState.seedStatus(${node.arguments[0].getText(ast)}, "${method === "add" ? "active" : "idle"}")`);
          return;
        }
        if (rule[method]) {
          edit(node.expression, `this.context.turnState.${rule[method]}`);
          // Calls' arguments can themselves access other activity selectors.
          for (const argument of node.arguments) visit(argument);
          return;
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const access = node.expression, rule = Object.hasOwn(rules, access.name.text) ? rules[access.name.text] : undefined;
      if (rule && node.name.text === "size") {
        assert.ok(rule.size, node.getText(ast));
        edit(node, `this.context.turnState.${rule.size}`);
        return;
      }
    }
    if (ts.isPropertyAccessExpression(node) && Object.hasOwn(rules, node.name.text)
      && (node.expression.kind === ts.SyntaxKind.ThisKeyword || node.expression.getText(ast) === "this.host()")) {
      const rule = rules[node.name.text];
      if (rule.iterate) {
        edit(node, `this.context.turnState.${rule.iterate}`);
        return;
      }
      throw new Error(`Unconverted activity access: ${file}: ${node.getText(ast)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  edits.sort((left, right) => right.start - left.start);
  let next = text, previous = text.length;
  for (const replacement of edits) {
    assert.ok(replacement.end <= previous, `Overlapping rewrite in ${file}`);
    next = next.slice(0, replacement.start) + replacement.replacement + next.slice(replacement.end);
    previous = replacement.start;
  }
  if (next !== text) {
    writeFileSync(file, next);
    changes.push({ file, edits: edits.length });
  }
}
console.log(JSON.stringify(changes));
