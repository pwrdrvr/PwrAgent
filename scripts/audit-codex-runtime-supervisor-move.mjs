import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// Run the extraction first to refresh its AST inventory and rewrite manifest.
const manifest = JSON.parse(readFileSync(".local/runtime-supervisor/proof-manifest.json", "utf8"));
const base = process.argv[2] ?? manifest.base;
const directory = "apps/desktop/src/main/app-server";
const registryPath = `${directory}/backend-registry.ts`;
const modulePath = `${directory}/codex-runtime-supervisor.ts`;
const original = execFileSync("git", ["show", `${base}:${registryPath}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const current = readFileSync(registryPath, "utf8");
function parse(file, text, className) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0, file);
  const node = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className);
  assert.ok(node, className);
  return { ast, node, members: new Map(node.members.map((member) => [member.name?.getText(ast) ?? "constructor", member])) };
}
const before = parse(registryPath, original, "DesktopBackendRegistry");
const moduleText = readFileSync(modulePath, "utf8");
const module = parse(modulePath, moduleText, "CodexRuntimeSupervisor");
function reverseModule(text) {
  for (const [name, rewrite] of Object.entries(manifest.contextRewrites)) text = text.replaceAll(`this.${rewrite}`, `this.${name}`);
  for (const group of new Set(Object.values(manifest.storeGroups))) text = text.replaceAll(`this.context.stores.${group}`, "this.overlayStore");
  for (const name of manifest.hostNames) text = text.replaceAll(`this.host().${name}`, `this.${name}`);
  return text.replaceAll("CodexRuntimeSupervisor", "DesktopBackendRegistry");
}
let movedCount = 0;
for (const name of manifest.moved) {
  const source = before.members.get(name);
  const target = module.members.get(name);
  assert.ok(source && target, name);
  const expected = source.getText(before.ast).replace(manifest.publicMethods.includes(name) ? /^private / : /^$/, "");
  assert.equal(reverseModule(target.getText(module.ast)), expected, `${name}: moved member changed`);
  assert.equal(moduleText.slice(target.getFullStart(), target.getStart(module.ast)).trim(), original.slice(source.getFullStart(), source.getStart(before.ast)).trim(), `${name}: leading comments changed`);
  movedCount += 1;
}
let reversed = current;
// Reverse the registry's call sites and its named module-state adapters.
for (const [name, getter] of Object.entries(manifest.stateReads)) reversed = reversed.replaceAll(`.codexRuntimeSupervisor.${getter}`, `.${name}`);
for (const name of manifest.moved) reversed = reversed.replaceAll(`.codexRuntimeSupervisor.${name}`, `.${name}`);
reversed = reversed.replaceAll("this.codexRuntimeSupervisor.setRuntimeRestartPending(true);", "this.codexRuntimeRestartPending = true;")
  .replaceAll("current().codexRuntimeSupervisor.setRuntimeRestartPending(value);", "current().codexRuntimeRestartPending = value;")
  .replaceAll("current().codexRuntimeSupervisor.setManagedRuntimeSwitchPending(value);", "current().managedCodexRuntimeSwitchPending = value;");
for (const [before, after] of manifest.blocks) reversed = reversed.replace(after, before);
const after = parse(registryPath, reversed, "DesktopBackendRegistry");
let retainedCount = 0;
for (const [name, member] of before.members) {
  if (manifest.moved.includes(name) || ["constructor", "constructionPorts"].includes(name)) continue;
  assert.equal(after.members.get(name)?.getText(after.ast), member.getText(before.ast), `${name}: retained registry member changed`);
  retainedCount += 1;
}
// Constructor differences are exactly the moved configuration assignments
// and the one injected module; every other statement keeps its original text.
const constructorStatements = (parsed, filter) => parsed.members.get("constructor").body.statements
  .filter((statement) => !filter(statement.getText(parsed.ast)))
  .map((statement) => statement.getText(parsed.ast));
assert.deepEqual(constructorStatements(after, (text) => text === "this.codexRuntimeSupervisor = dependencies.codexRuntimeSupervisor;"),
  constructorStatements(before, (text) => manifest.configuration.some((name) => text === `this.${name} = dependencies.${name};`)), "constructor drift");

// Original construction entries are unchanged after reversing delegation;
// additional entries supply only the new module's host, with mutable setters.
function ports(parsed) {
  return parsed.members.get("constructionPorts").body.statements.find(ts.isReturnStatement).expression.properties;
}
const portKey = (node, ast) => `${ts.isSetAccessorDeclaration(node) ? "set" : "get"}:${node.name.getText(ast)}`;
const oldPorts = new Map(ports(before).map((node) => [portKey(node, before.ast), node.getText(before.ast)]));
const addedPorts = [];
for (const node of ports(after)) {
  const key = portKey(node, after.ast);
  if (oldPorts.has(key)) assert.equal(node.getText(after.ast), oldPorts.get(key), `port drift: ${key}`);
  else {
    assert.ok(manifest.hostNames.includes(node.name.getText(after.ast)), `unexpected port: ${key}`);
    addedPorts.push(key);
  }
}
assert.ok([...oldPorts.keys()].every((key) => ports(after).some((node) => portKey(node, after.ast) === key)), "missing construction port");
const field = after.members.get("codexRuntimeSupervisor");
assert.equal(field.getText(after.ast), "private readonly codexRuntimeSupervisor: CodexRuntimeSupervisor;");
assert.deepEqual([...after.members.keys()].filter((name) => !before.members.has(name)), ["codexRuntimeSupervisor"]);
for (const name of manifest.facades) {
  const old = before.members.get(name);
  const facade = after.members.get(name);
  assert.ok(facade, name);
  assert.equal(reversed.slice(facade.getStart(after.ast), facade.body.getStart(after.ast)), original.slice(old.getStart(before.ast), old.body.getStart(before.ast)).replace(/^async /, ""), `facade signature: ${name}`);
}
// Non-import top-level declarations remain byte-identical. There are no new
// rollout I/O operations, helpers or hidden changes outside the class.
const declarations = (ast) => ast.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isClassDeclaration(node)).map((node) => node.getText(ast));
assert.deepEqual(declarations(after.ast), declarations(before.ast));
for (const fixture of ["turn-event-stream.json", "sqlite-write-budgets.json"]) {
  const file = `apps/desktop/src/main/__tests__/fixtures/${fixture}`;
  assert.deepEqual(readFileSync(file), execFileSync("git", ["show", `${base}:${file}`]), fixture);
}
writeFileSync(".local/runtime-supervisor/proof-result.json", JSON.stringify({ base, movedCount, retainedCount, addedPorts, facades: manifest.facades, fixturesUnchanged: true }, null, 2) + "\n");
console.log(`PASS: ${movedCount} moved members and their comments reverse to the original spans; ${retainedCount} retained members, constructor statements and all original ports are unchanged.`);
console.log(`Only ${manifest.facades.length} original-signature facades, the injected module, ${addedPorts.length} host entries and pruned imports differ. Both fixtures are byte-identical to ${base}.`);
