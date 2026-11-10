import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

// The phase-0 base is pinned so the audit remains reproducible after merge.
// On a rebased branch, pass the new base as the first argument.
const base = process.argv[2] ?? "108fa889e24d4d5d3aecc30a7b24bac773d4b06f";
const directory = "apps/desktop/src/main/app-server";
const registry = `${directory}/backend-registry.ts`;
const modules = [
  "backend-registry-types",
  "backend-registry-notification-values",
  "backend-registry-notifications",
  "backend-registry-runtime-helpers",
  "thread-turn-keys",
  "thread-transcript-helpers",
  "codex-thread-config",
  "thread-launchpad-helpers",
  "thread-usage-math",
  "thread-model-options",
  "linked-directory-identity",
  "thread-archive-helpers",
  "thread-restart-helpers",
  "thread-orchestration-prompts",
  "codex-native-subagents",
  "thread-inspection-summaries",
  "task-monitor-helpers",
  "thread-forge-helpers",
];

function declarations(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0, `${file}: invalid TypeScript`);
  const occurrences = new Map();
  const result = new Map();
  for (const node of tree.statements) {
    if (ts.isImportDeclaration(node)) continue;
    const names = ts.isVariableStatement(node)
      ? node.declarationList.declarations.map((entry) => entry.name.getText(tree))
      : node.name ? [node.name.getText(tree)] : [];
    assert.ok(names.length, `${file}: unrecognized top-level statement`);
    const name = names.join(",");
    const occurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, occurrence + 1);
    const key = `${name}#${occurrence}`;
    let text = node.getText(tree);
    // Only an added/removed export modifier is permitted inside a declaration.
    const exported = node.modifiers?.find((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) {
      const offset = exported.getStart(tree) - node.getStart(tree);
      assert.equal(text.slice(offset, offset + 7), "export ");
      text = text.slice(0, offset) + text.slice(offset + 7);
    }
    const comments = source.slice(node.getFullStart(), node.getStart(tree)).trim();
    result.set(key, { name, text, comments });
  }
  return { tree, result };
}

const beforeText = execFileSync("git", ["show", `${base}:${registry}`], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
const before = declarations(registry, beforeText).result;
const homes = new Map();
for (const file of [registry, ...modules.map((module) => `${directory}/${module}.ts`)]) {
  const source = readFileSync(file, "utf8");
  const { tree, result } = declarations(file, source);
  if (file !== registry) {
    function checkImport(node) {
      if (ts.isStringLiteral(node) && /(?:^|\/)backend-registry(?:\.ts)?$/.test(node.text)) {
        assert.fail(`${file}: helper references backend-registry`);
      }
      ts.forEachChild(node, checkImport);
    }
    checkImport(tree);
  }
  for (const [key, declaration] of result) {
    assert.ok(before.has(key), `${file}: added declaration ${key}`);
    assert.ok(!homes.has(key), `${key}: duplicate declaration`);
    homes.set(key, { file, ...declaration });
  }
}

let moved = 0;
let retained = 0;
for (const [key, old] of before) {
  const current = homes.get(key);
  assert.ok(current, `${key}: declaration missing`);
  assert.equal(current.text, old.text, `${key}: declaration text changed in ${current.file}`);
  assert.equal(current.comments, old.comments, `${key}: leading comments changed in ${current.file}`);
  if (current.file === registry) retained += 1;
  else moved += 1;
}
const afterLines = readFileSync(registry, "utf8").split("\n").length - 1;
const beforeLines = beforeText.split("\n").length - 1;
console.log(`PASS: ${moved} moved declarations are byte-identical (excluding export modifiers); ${retained} retained declarations, including the registry class, are unchanged.`);
console.log(`Checked declaration comments, overloads, completeness, uniqueness, and absence of helper references to backend-registry.`);
console.log(`${modules.length} helper modules; backend-registry.ts: ${beforeLines} -> ${afterLines} lines (${beforeLines - afterLines} fewer).`);
console.log(`Base: ${base}`);
