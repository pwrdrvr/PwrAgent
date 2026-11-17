import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import path from "node:path";

const baseline = "337cf083a1894aab6e6e8b5328c55b5a97411cde";
const file = "apps/desktop/src/main/messaging/core/messaging-controller.ts";
const directory = ".local/pwr-149-commands/inventory";
const names = ["handleCommand", "handleScheduleCommand", "handleScheduledCommand", "deliverScheduledActionError", "routeUnknownCommandToBoundThread", "presentThreadCommandNeedsBinding", "handleReviewCommand", "presentHelp", "handleDefaultAgentCommand", "handleMonitorCommand", "handleMonitorTopicCommand", "continueClaudeThreadInNewSession"];
const config = ts.readConfigFile("apps/desktop/tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, "apps/desktop");
const compilerHost = ts.createCompilerHost(parsed.options);
const read = compilerHost.readFile.bind(compilerHost);
const original = execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
compilerHost.readFile = name => path.resolve(name) === path.resolve(file) ? original : read(name);
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true }, compilerHost);
const checker = program.getTypeChecker();
const source = program.getSourceFile(file);
const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingController");
const globals = new Map();
const host = new Map();
const ports = { store: new Set(), backend: new Set() };
const where = node => ({ file: node.getSourceFile().fileName, line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 });
const type = node => checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation);
function inspect(node) {
  if (ts.isIdentifier(node)) {
    for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? []) {
      if (declaration.parent === source && (ts.isFunctionDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) && !globals.has(declaration.name.text)) {
        globals.set(declaration.name.text, declaration);
        inspect(declaration);
      }
    }
  }
  if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && !names.includes(node.name.text) && !["options", "now", "capabilityProfile"].includes(node.name.text)) host.set(node.name.text, { ...where(node), type: type(node) });
  if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^this\.options\.(store|backend)$/.test(node.expression.getText())) ports[node.expression.name.text].add(node.name.text);
  ts.forEachChild(node, inspect);
}
const methods = names.map(name => owner.members.find(node => node.name?.getText() === name));
if (methods.some(method => !method)) throw new Error("Missing pinned baseline command");
methods.forEach(inspect);
const seams = [];
for (const file of program.getSourceFiles().filter(file => file.fileName.includes("__tests__"))) {
  const visit = node => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && checker.getPropertiesOfType(checker.getTypeAtLocation(node)).some(member => names.includes(member.name))) seams.push({ ...where(node), kind: "cast", text: node.getText() });
    if (ts.isCallExpression(node) && /spyOn|Object\.(assign|create|setPrototypeOf)/.test(node.expression.getText()) && names.some(name => node.getText().includes(name))) seams.push({ ...where(node), kind: "spy-override", text: node.getText() });
    if (ts.isObjectLiteralExpression(node) && node.properties.some(property => property.name && names.includes(property.name.getText().replaceAll('"', "")))) seams.push({ ...where(node), kind: "stand-in", text: node.getText() });
    ts.forEachChild(node, visit);
  };
  visit(file);
}
mkdirSync(directory, { recursive: true });
const report = {
  baseline, names,
  methods: methods.map(node => ({ ...where(node), name: node.name.getText(), text: node.getText() })),
  globals: [...globals].map(([name, node]) => ({ ...where(node), name, text: node.getText() })),
  host: Object.fromEntries(host), ports: Object.fromEntries(Object.entries(ports).map(([name, values]) => [name, [...values]])), seams,
};
writeFileSync(`${directory}/commands.json`, `${JSON.stringify(report, null, 2)}\n`);
// The broad audit retains backend mocks with similarly named methods. Resolved
// references distinguish actual facade callers; do not migrate bridge mocks.
const references = [];
const effects = [];
for (const sourceFile of program.getSourceFiles()) {
  const visit = node => {
    if (ts.isIdentifier(node) && names.includes(node.text)) {
      const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
      if (declarations.some(declaration => methods.includes(declaration))) references.push({ ...where(node), name: node.text });
    }
    if (sourceFile === source && methods.some(method => node.pos >= method.pos && node.end <= method.end)) {
      if (ts.isCallExpression(node) || ts.isAwaitExpression(node) || ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isIfStatement(node) || ts.isTryStatement(node) || ts.isBinaryExpression(node)) {
        const boundaries = [];
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isTryStatement(parent) || ts.isIfStatement(parent)) boundaries.push(where(parent));
        }
        effects.push({ ...where(node), kind: ts.SyntaxKind[node.kind], text: node.getText(), boundaries });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
writeFileSync(`${directory}/effects.json`, `${JSON.stringify({ references, effects }, null, 2)}\n`);
const tokens = text => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) result.push(scanner.getTokenText());
  return JSON.stringify(result);
};
if (process.argv.includes("--verify")) {
  const current = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const facade = current.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingController");
  const moved = ts.createSourceFile("commands.ts", readFileSync("apps/desktop/src/main/messaging/core/messaging-command-handlers.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const commands = moved.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingCommandHandlers");
  const undo = text => text.replaceAll("this.context.host().", "this.").replaceAll("this.context.store", "this.options.store").replaceAll("this.context.backend", "this.options.backend").replaceAll("this.context.now", "this.now").replaceAll("this.context.capabilityProfile", "this.capabilityProfile");
  for (const method of methods) {
    const actual = commands.members.find(node => node.name?.getText() === method.name.getText());
    if (!actual || tokens(undo(actual.body.getText())) !== tokens(method.body.getText())) throw new Error(`Changed command effects: ${method.name.getText()}`);
    if (facade.members.some(node => node.name?.getText() === method.name.getText())) throw new Error(`Obsolete facade operation: ${method.name.getText()}`);
  }
  for (const method of owner.members.filter(node => ts.isMethodDeclaration(node) && !names.includes(node.name.getText()))) {
    const actual = facade.members.find(node => node.name?.getText() === method.name.getText());
    if (!actual || tokens(actual.getText().replaceAll("this.commandHandlers.", "this.")) !== tokens(method.getText())) throw new Error(`Changed retained caller: ${method.name.getText()}`);
  }
  const helpers = ts.createSourceFile("helpers.ts", readFileSync("apps/desktop/src/main/messaging/core/messaging-command-helpers.ts", "utf8"), ts.ScriptTarget.Latest, true);
  for (const [name, original] of globals) {
    const actual = helpers.statements.find(node => node.name?.getText() === name);
    if (!actual || tokens(actual.getText().replace(/^export /, "")) !== tokens(original.getText())) throw new Error(`Changed helper: ${name}`);
  }
}
console.log(JSON.stringify({ baseline, methods: methods.length, globals: globals.size, hostPorts: host.size, ports: report.ports, broadSeams: seams.length, resolvedReferences: references.length, effects: effects.length, verified: process.argv.includes("--verify") }));
