import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// Full AST evidence stays off stdout. Run before and after the extraction.
const index = process.argv.indexOf("--output");
const output = index < 0 ? ".local/pwr-148/inventory" : process.argv[index + 1];
mkdirSync(output, { recursive: true });
const refAt = process.argv.indexOf("--ref");
const ref = refAt < 0 ? undefined : process.argv[refAt + 1];
const files = ref
  ? execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "apps/desktop/src"], { encoding: "utf8" }).trim().split("\n").filter(file => /\.tsx?$/.test(file))
  : execFileSync("rg", ["--files", "apps/desktop/src", "-g", "*.ts", "-g", "*.tsx"], { encoding: "utf8" }).trim().split("\n");
const historicalSources = new Map();
if (ref) {
  const changed = execFileSync("git", ["diff", "--name-only", ref, "--", "apps/desktop/src"], { encoding: "utf8" }).trim().split("\n").filter(file => files.includes(file));
  for (const file of changed) historicalSources.set(path.resolve(file), execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" }));
}
const config = ts.readConfigFile("apps/desktop/tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, "apps/desktop");
const options = { ...parsed.options, noEmit: true };
const host = ts.createCompilerHost(options);
const readFile = host.readFile.bind(host);
host.readFile = file => historicalSources.get(path.resolve(file)) ?? readFile(file);
const program = ts.createProgram(files, options, host);
const checker = program.getTypeChecker();
const nodes = [], callers = [], ports = [], standIns = [], optionality = [], registration = [], recordedHooks = [];
const operations = new Set(["emit", "emitEvent", "emitWithTranscriptImages", "emitAfterLiveThreadUsageRegistration", "constructionPorts", "run", "observe", "onTurnStarted", "onTurnTerminal", "onStatusChanged", "onEvent"]);
const originalHub = ts.createSourceFile("baseline-registry.ts", execFileSync("git", ["show", "c56bff20ea68e785592b0c70e89e79cab8243ffa:apps/desktop/src/main/app-server/backend-registry.ts"], { encoding: "utf8" }), ts.ScriptTarget.Latest, true);
const collectionOperations = new Set(["get", "set", "has", "add", "delete", "clear", "values", "entries", "keys", "some", "find", "filter", "map", "push", "startsWith", "trim", "join", "from", "now", "warn", "info"]);
const sourceFiles = files.map(file => program.getSourceFile(file));
const site = (source, node) => ({ file: source.fileName, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
function owner(node) {
  const result = [];
  for (let p = node; p; p = p.parent) {
    if ((ts.isFunctionLike(p) || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) && p.name) result.unshift(p.name.getText());
    if (ts.isConstructorDeclaration(p)) result.unshift("constructor");
  }
  return result.join(".");
}
function catches(node) {
  const result = [];
  for (let p = node.parent; p; p = p.parent) if (ts.isTryStatement(p)) result.push(p.getText());
  return result;
}
function declarations(node) {
  return checker.getSymbolAtLocation(node)?.declarations?.map(d => ({ ...site(d.getSourceFile(), d), owner: owner(d) })) ?? [];
}
// First find every direct hub operation, including store/collaborator calls.
for (const source of [originalHub, ...sourceFiles]) {
  if (!source) throw new Error("Missing source");
  if (source.parseDiagnostics.length) throw new Error(`Syntax error: ${source.fileName}`);
  function find(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText() === "emitAfterLiveThreadUsageRegistration") {
      function call(n) {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && !collectionOperations.has(n.expression.name.text)) operations.add(n.expression.name.text);
        ts.forEachChild(n, call);
      }
      call(node);
    }
    ts.forEachChild(node, find);
  }
  find(source);
}
for (const source of sourceFiles) {
  function visit(node) {
    const scope = owner(node);
    if (ts.isVariableDeclaration(node) && node.name.getText() === "observers" && source.fileName.endsWith("backend-registry-wiring.ts") && node.initializer && ts.isArrayLiteralExpression(node.initializer)) registration.push(...node.initializer.elements.map((item, index) => ({ index, ...site(source, item), text: item.getText() })));
    if (ts.isVariableDeclaration(node) && node.name.getText() === "HUB_HOOKS") recordedHooks.push({ ...site(source, node), text: node.getText() });
    const inPipeline = scope.includes("emitAfterLiveThreadUsageRegistration")
      || scope.includes("DesktopBackendRegistry.emit") || /\.observe(?:Turn|Usage|Review|Monitor|Directory|Runtime)/.test(scope) || scope.includes(".turnEventObserver") || /(?:turn-event-observer|registry-turn-events)\.ts$/.test(source.fileName)
      || /(?:\.onTurnStarted|\.onTurnTerminal|\.onStatusChanged|\.onEvent)/.test(scope);
    const kind = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? "read" : ts.isCallExpression(node) ? "call" : ts.isAwaitExpression(node) ? "await"
      : ts.isReturnStatement(node) ? "return" : ts.isThrowStatement(node) ? "throw"
      : ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node) ? "branch"
      : ts.isTryStatement(node) ? "exception-boundary"
      : ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? "mutation" : undefined;
    if (inPipeline && kind) nodes.push({ ...site(source, node), owner: scope, kind, position: node.getStart(source), text: node.getText(), branches: (function () { const result = []; for (let p = node.parent; p; p = p.parent) if (ts.isIfStatement(p)) result.unshift(p.expression.getText()); return result; })(), catches: catches(node), declarations: ts.isCallExpression(node) ? declarations(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression) : [] });
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && operations.has(node.text)) callers.push({ ...site(source, node), owner: scope, name: node.text, text: node.parent.getText(), declarations: declarations(node), catches: catches(node) });
    if (scope.includes("constructionPorts") || /RegistryContext|RegistryHost|Host(?:\.|$)/.test(scope)
      || source.fileName.endsWith("backend-registry-wiring.ts")) {
      if (ts.isPropertyAssignment(node) || ts.isGetAccessorDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertySignature(node) || ts.isNewExpression(node)) ports.push({ ...site(source, node), owner: scope, text: node.getText(), catches: catches(node) });
    }
    if (source.fileName.includes("__tests__")) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "prototype") standIns.push({ ...site(source, node), kind: "prototype", owner: scope, text: node.parent.getText(), catches: catches(node) });
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const type = checker.getTypeAtLocation(node);
        const members = checker.getPropertiesOfType(type).map(p => p.name);
        if (members.some(m => operations.has(m)) || /Registry|Host|Members/.test(node.type.getText())) standIns.push({ ...site(source, node), kind: "cast", owner: scope, text: node.getText(), members, namedType: type.aliasSymbol?.declarations?.map(d => site(d.getSourceFile(), d)), catches: catches(node) });
      }
      if (ts.isCallExpression(node) && /spyOn|Object\.(assign|create|setPrototypeOf)/.test(node.expression.getText())) standIns.push({ ...site(source, node), kind: "spy-override-prototype", owner: scope, text: node.getText(), catches: catches(node) });
      if (ts.isObjectLiteralExpression(node) && node.properties.some(p => p.name && operations.has(p.name.getText().replaceAll('"', "")))) standIns.push({ ...site(source, node), kind: "object-stand-in", owner: scope, text: node.getText(), catches: catches(node) });
    }
    if (ts.isTypeAliasDeclaration(node) && /^(Registry.*Store|BackendRegistryOverlayStoreLike)$/.test(node.name.text)) optionality.push({ ...site(source, node), name: node.name.text, properties: checker.getPropertiesOfType(checker.getTypeAtLocation(node)).map(p => ({ name: p.name, optional: Boolean(p.flags & ts.SymbolFlags.Optional), type: checker.typeToString(checker.getTypeOfSymbolAtLocation(p, node)) })) });
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const summary = { command: "node scripts/inventory-turn-event-observers.mjs", base: execFileSync("git", ["rev-parse", ref ?? "HEAD"], { encoding: "utf8" }).trim(), files: files.length, nodes: nodes.length, callers: callers.length, ports: ports.length, standIns: standIns.length, optionality: optionality.length, syntaxFailures: 0, warnings: [] };
for (const [name, value] of Object.entries({ summary, nodes, callers, ports, standIns, optionality, registration, recordedHooks })) writeFileSync(path.join(output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
console.log(JSON.stringify(summary));
