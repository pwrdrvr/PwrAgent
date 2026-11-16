import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const directory = "apps/desktop/src/main/__tests__";
const files = ["backend-registry.test.ts", "backend-registry-forge-tools.test.ts", "backend-registry-mcp-gateway.test.ts",
  "backend-registry-forge-project-rules.test.ts", "backend-registry-dynamic-tool-dispatch.test.ts",
  "backend-registry-usage-turn-end.test.ts", "codex-model-provider-publication.property.test.ts", "owner-conformance.test.ts"];
const rules = {
  activeTurnKeys: { add: "registerTurn", has: "hasRegisteredTurn", delete: "unregisterTurn", iterate: "registeredTurnKeys()", size: "registeredTurnCount" },
  activeCodexTurnModes: { set: "acceptExecution", get: "executionMode", has: "ownsExecution", delete: "forgetExecution", keys: "executionKeys" },
  activeCodexTurnCollaborationModes: { set: "setCollaboration", get: "collaborationMode", keys: "collaborationKeys", size: "collaborationKeys().length" },
  reservedCodexStartThreadIds: { has: "hasStartReservation", size: "startReservationCount" },
  codexRetryableOperations: { get: "retryOperation", has: "hasRetry" },
  startingTurnOrigins: { size: "startingOrigins().length" },
  activeCodexReviewTurnKeys: {},
};
const owner = "registryModules(registry).turnState";
for (const name of files) {
  const file = `${directory}/${name}`;
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  const replace = (node, text) => edits.push({ start: node.getStart(ast), end: node.getEnd(), text });
  function visit(node) {
    if (ts.isPropertySignature(node) && Object.hasOwn(rules, node.name.getText(ast))) { replace(node, ""); return; }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression)) {
      const access = node.expression.expression, rule = Object.hasOwn(rules, access.name.text) ? rules[access.name.text] : undefined;
      if (rule) {
        const operation = node.expression.name.text;
        if (operation === "clear" && access.name.text === "activeTurnKeys") {
          replace(node, `${owner}.registeredTurnKeys().forEach(key => ${owner}.unregisterTurn(key))`);
        } else if (operation === "has" && access.name.text === "activeCodexTurnCollaborationModes") {
          replace(node, `(${owner}.collaborationMode(${node.arguments[0].getText(ast)}) !== undefined)`);
        } else {
          assert.ok(rule[operation], `${file}: ${node.getText(ast)}`);
          replace(node.expression, `${owner}.${rule[operation]}`);
          for (const argument of node.arguments) visit(argument);
        }
        return;
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const rule = Object.hasOwn(rules, node.expression.name.text) ? rules[node.expression.name.text] : undefined;
      if (rule && node.name.text === "size") {
        assert.ok(rule.size, `${file}: ${node.getText(ast)}`);
        replace(node, `${owner}.${rule.size}`);
        return;
      }
    }
    if (ts.isPropertyAccessExpression(node) && Object.hasOwn(rules, node.name.text)) {
      const rule = rules[node.name.text];
      // The two aliases of mutable collections are deliberately migrated by
      // hand, so no snapshot accidentally becomes a stale mutable stand-in.
      if (["activeCodexReviewTurnKeys", "reservedCodexStartThreadIds"].includes(node.name.text)) return;
      assert.ok(rule.iterate, `${file}: ${node.getText(ast)}`);
      replace(node, `${owner}.${rule.iterate}`);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let next = source, previous = source.length;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    assert.ok(edit.end <= previous, `${file}: overlapping edit`);
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    previous = edit.start;
  }
  if (!next.includes("import { registryModules }") && !/import \{[^}]*registryModules[^}]*\} from "\.\.\/app-server\/backend-registry-wiring";/.test(next)) {
    next = `import { registryModules } from "../app-server/backend-registry-wiring";\n${next}`;
  }
  writeFileSync(file, next);
}
console.log(`Migrated ${files.length} registry-backed activity test files; module stand-ins require their real context.`);
