import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import ts from "typescript";

// Run after the extraction. Covers inline and locally named cast types;
// mixed casts retain only registry-owned members and get a separate owner.
const moved = new Set(JSON.parse(readFileSync(".local/runtime-supervisor/map.json", "utf8")).members.map((member) => member.name));
const facades = new Set(["terminateBackgroundTerminal", "listBackgroundTerminals", "startCodexIdleThreadUnsubscriber", "startCodexAppServerRecycler", "readCodexAppServerDiagnostics", "onCodexAppServerRestartStatusChanged", "getCodexAppServerRestartStatus", "restartCodexAppServer"]);
const root = "apps/desktop/src/main/__tests__";
const report = [];
function visit(node, callback) { callback(node); ts.forEachChild(node, (child) => visit(child, callback)); }
for (const relative of readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) => /\.tsx?$/.test(name))) {
  const file = `${root}/${relative}`;
  let text = readFileSync(file, "utf8");
  if (!text.includes("registry")) continue;
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const aliases = new Map();
  visit(ast, (node) => { if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type); });
  function typeMembers(node) {
    if (ts.isTypeLiteralNode(node)) return [...node.members];
    if (ts.isTypeReferenceNode(node) && aliases.has(node.typeName.getText(ast))) return typeMembers(aliases.get(node.typeName.getText(ast)));
    if (ts.isIntersectionTypeNode(node)) return node.types.flatMap(typeMembers);
    return [];
  }
  const replacements = [];
  visit(ast, (node) => {
    if (!ts.isAsExpression(node)) return;
    const fields = typeMembers(node.type);
    const owned = fields.filter((field) => moved.has(field.name?.getText(ast)));
    if (!owned.length) return;
    let receiver = node.expression;
    while (ts.isAsExpression(receiver) || ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
    // Other providers use the same method names. Only registry casts move.
    if (!ts.isIdentifier(receiver) || !/registry/i.test(receiver.text)) return;
    const owner = `registryModules(${receiver.getText(ast)}).codexRuntimeSupervisor`;
    const remaining = fields.filter((field) => !owned.includes(field));
    if (!remaining.length) {
      replacements.push({ start: receiver.getStart(ast), end: receiver.end, text: owner });
    } else {
      assert.ok(ts.isVariableDeclaration(node.parent), `${file}: mixed cast outside a variable`);
      const declaration = node.parent;
      const statement = declaration.parent.parent;
      const block = statement.parent;
      const name = declaration.name.getText(ast);
      replacements.push({ start: node.type.getStart(ast), end: node.type.end, text: `{\n${remaining.map((field) => `      ${field.getText(ast)}`).join("\n")}\n    }` });
      const properties = owned.filter((field) => !ts.isMethodSignature(field));
      if (properties.length) replacements.push({ start: statement.end, end: statement.end, text: `\n    const runtime = ${owner} as unknown as {\n${properties.map((field) => `      ${field.getText(ast)}`).join("\n")}\n    };` });
      visit(block, (access) => {
        if (ts.isPropertyAccessExpression(access) && access.expression.getText(ast) === name && owned.some((field) => field.name.getText(ast) === access.name.text)) {
          replacements.push({ start: access.expression.getStart(ast), end: access.expression.end, text: properties.some((field) => field.name.getText(ast) === access.name.text) ? "runtime" : owner });
        }
      });
    }
    report.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind: "cast", members: owned.map((field) => field.name.getText(ast)) });
  });
  visit(ast, (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "registry"
      && moved.has(node.name.text) && !facades.has(node.name.text)) {
      replacements.push({ start: node.expression.getStart(ast), end: node.expression.end, text: "registryModules(registry).codexRuntimeSupervisor" });
      report.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind: "method", members: [node.name.text] });
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "vi.spyOn" && node.arguments[0]?.getText(ast) === "registry"
      && ts.isStringLiteralLike(node.arguments[1]) && moved.has(node.arguments[1].text)) {
      replacements.push({ start: node.arguments[0].getStart(ast), end: node.arguments[0].end, text: "registryModules(registry).codexRuntimeSupervisor" });
      report.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind: "spy", members: [node.arguments[1].text] });
    }
  });
  if (!replacements.length) continue;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  if (!text.includes('import { registryModules }') && !/import \{[^}]*\bregistryModules\b[^}]*\}/.test(text)) {
    text = 'import { registryModules } from "../app-server/backend-registry-wiring";\n' + text;
  }
  writeFileSync(file, text);
}
writeFileSync(".local/runtime-supervisor/test-migration.json", JSON.stringify(report, null, 2) + "\n");
console.log(`Rewrote ${report.length} casts, calls and spies in ${new Set(report.map((row) => row.file)).size} test files. Full AST report: .local/runtime-supervisor/test-migration.json`);
