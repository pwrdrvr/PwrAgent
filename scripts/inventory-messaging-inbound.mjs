import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import path from "node:path";

const baseline = "c7219ed95c1d7f70f10fd6648eb65e7317857cfc";
const file = "apps/desktop/src/main/messaging/core/messaging-controller.ts";
const directory = ".local/pwr-149-inbound/inventory";
const names = ["handleText", "bootstrapDefaultAgentForAcceptedMessage", "defaultAgentTargetIsAgentThread", "deliverDefaultAgentBootstrapError", "handleMedia", "shouldHandleAmbientSharedMessage", "responseModeForConversation", "revokeDefaultAgentRouteForFailedStart", "admitTurnInput", "measureHandledToRoutedSubspan", "measureHandledToRoutedSyncSubspan", "recordHandledToRoutedSubspan", "admissionTimingForEvent", "markAdmissionStage", "addInputPreparationTiming", "takeAdmissionStageTiming", "handleAdmittedTurnBundle", "prependPendingSkillSelection", "findPendingNewThreadSession", "appendPendingNewThreadPrompt", "schedulePendingNewThreadPrompt", "flushPendingNewThreadPrompt", "deliverNewThreadPromptFailure", "clearPendingNewThreadPrompt", "pendingNewThreadPromptKey", "prepareTurnInput", "revokeExpiredPrivateReplyContinuation", "cleanupExpiredPrivateReplyContinuations", "resolveMessagingPdfHandling", "resolvePdfAnalysisEnabled", "startPreparedInput", "isTurnOccupied", "waitForPendingTurnFailureHandlers", "adoptStartedTurn", "queuePreparedInput", "refreshInboundMetadata", "createNewThreadFromPromptBundle", "createMessagingEnvironmentSetupReporter", "deliverMessagingEnvironmentSetupFinal", "loadDefaultAgentBackendSummaries"];
const fields = ["admissionStageMarks", "pendingNewThreadPrompts", "pendingFullAccessNewThreadPrompts"];
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
const ports = { store: new Set(), backend: new Set(), adapter: new Set() };
const options = new Map();
const ownerReads = new Map();
const where = node => ({ file: node.getSourceFile().fileName, line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 });
const type = node => checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation);
function roleOf(node, seen = new Set()) {
  if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "this.options" && Object.hasOwn(ports, node.name.text)) return node.name.text;
  if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === "adapter") return "adapter";
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const role = roleOf(declaration.initializer, seen);
      if (role) return role;
    }
  }
}
function inspect(node) {
  // A whole receiver or computed member cannot be moved by the explicit port
  // substitutions below. Fail the audit instead of silently changing `this`.
  if (node.kind === ts.SyntaxKind.ThisKeyword && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
    throw new Error(`Unported facade receiver at ${JSON.stringify(where(node))}`);
  }
  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    for (const declaration of symbol?.declarations ?? []) {
      const top = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
      if (top.parent === source && (ts.isFunctionDeclaration(top) || ts.isTypeAliasDeclaration(top) || ts.isInterfaceDeclaration(top) || ts.isVariableStatement(top) || ts.isEnumDeclaration(top))) {
        const name = declaration.name?.getText();
        if (name && !globals.has(name)) { globals.set(name, top); inspect(top); }
      }
    }
  }
  if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && !names.includes(node.name.text) && !fields.includes(node.name.text) && !["options", "now", "capabilityProfile", "logger", "adapter"].includes(node.name.text)) host.set(node.name.text, { ...where(node), type: type(node), kind: ts.isMethodDeclaration(owner.members.find(member => member.name?.getText() === node.name.text)) ? "method" : "data" });
  if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "this.options" && !["store", "backend", "adapter"].includes(node.name.text)) options.set(node.name.text, type(node));
  if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^this\.options\.(store|backend|adapter)$/.test(node.expression.getText())) ports[node.expression.name.text].add(node.name.text);
  if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const key = node.expression.name.text;
    if (!ownerReads.has(key)) ownerReads.set(key, new Set());
    ownerReads.get(key).add(node.name.text);
    if (key === "adapter") ports.adapter.add(node.name.text);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const role = roleOf(node.expression);
    if (role) ports[role].add(node.name.text);
  }
  // A whole backend can flow through an object parameter to another narrow
  // helper. Include the contextual Pick, not just syntactically direct calls.
  if (ts.isPropertyAssignment(node)) {
    const role = roleOf(node.initializer);
    const contextual = role && checker.getContextualType(node.parent);
    const property = contextual?.getProperty(node.name.getText());
    if (property) for (const member of checker.getTypeOfSymbolAtLocation(property, node).getProperties()) ports[role].add(member.name);
  }
  ts.forEachChild(node, inspect);
}
const methods = names.map(name => owner.members.find(node => node.name?.getText() === name));
if (methods.some(method => !method)) throw new Error("Missing pinned baseline inbound operation");
methods.forEach(inspect);
fields.forEach(name => inspect(owner.members.find(node => node.name?.getText() === name)));
const signatures = ts.createSourceFile("ports.ts", [...host.values()].map(value => value.type).concat([...options.values()]).join(";\n"), ts.ScriptTarget.Latest, true);
const typeNames = new Set();
function findTypeNames(node) { if (ts.isIdentifier(node)) typeNames.add(node.text); ts.forEachChild(node, findTypeNames); }
findTypeNames(signatures);
for (const node of source.statements) if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && typeNames.has(node.name.text) && !globals.has(node.name.text)) { globals.set(node.name.text, node); inspect(node); }
const seamNames = [...names, ...fields];
const seams = [];
for (const file of program.getSourceFiles().filter(file => file.fileName.includes("__tests__"))) {
  const visit = node => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && checker.getPropertiesOfType(checker.getTypeAtLocation(node)).some(member => seamNames.includes(member.name))) seams.push({ ...where(node), kind: "cast", text: node.getText() });
    if (ts.isCallExpression(node) && /spyOn|Object\.(assign|create|setPrototypeOf)/.test(node.expression.getText()) && seamNames.some(name => node.getText().includes(name))) seams.push({ ...where(node), kind: "spy-override", text: node.getText() });
    if (ts.isObjectLiteralExpression(node) && node.properties.some(property => property.name && seamNames.includes(property.name.getText().replaceAll('"', "")))) seams.push({ ...where(node), kind: "stand-in", text: node.getText() });
    ts.forEachChild(node, visit);
  };
  visit(file);
}
mkdirSync(directory, { recursive: true });
const report = {
  baseline, names,
  fields,
  methods: methods.map(node => ({ ...where(node), name: node.name.getText(), text: node.getText() })),
  globals: [...globals].map(([name, node]) => ({ ...where(node), name, text: node.getText() })),
  host: Object.fromEntries(host), ports: Object.fromEntries(Object.entries(ports).map(([name, values]) => [name, [...values]])), seams, options: Object.fromEntries(options), ownerReads: Object.fromEntries([...ownerReads].map(([name, keys]) => [name, [...keys]])),
};
writeFileSync(`${directory}/inbound.json`, `${JSON.stringify(report, null, 2)}\n`);
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
  const movedFile = "apps/desktop/src/main/messaging/core/messaging-inbound-turns.ts";
  const moved = ts.createSourceFile(movedFile, readFileSync(movedFile, "utf8"), ts.ScriptTarget.Latest, true);
  const inbound = moved.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingInboundTurns");
  const undo = text => text.replaceAll("this.context.host().", "this.")
    .replaceAll("this.context.store", "this.options.store").replaceAll("this.context.backend", "this.options.backend")
    .replaceAll("this.context.config.", "this.options.").replaceAll("this.context.now", "this.now")
    .replaceAll("this.context.capabilityProfile", "this.capabilityProfile").replaceAll("this.context.adapter", "this.adapter")
    .replaceAll("this.context.logger", "this.logger")
    .replaceAll('ReturnType<MessagingInboundHost["beginTurnPreparationActivity"]>', 'ReturnType<MessagingController["beginTurnPreparationActivity"]>');
  for (const method of methods) {
    const actual = inbound.members.find(node => node.name?.getText() === method.name.getText());
    if (!actual || tokens(undo(actual.getText())) !== tokens(method.getText().replace(/^private /, ""))) throw new Error(`Changed inbound effects or signature: ${method.name.getText()}`);
    if (facade.members.some(node => node.name?.getText() === method.name.getText())) throw new Error(`Obsolete facade operation: ${method.name.getText()}`);
  }
  const helpers = ts.createSourceFile("helpers.ts", readFileSync("apps/desktop/src/main/messaging/core/messaging-inbound-helpers.ts", "utf8"), ts.ScriptTarget.Latest, true);
  for (const [name, expected] of globals) {
    const actual = helpers.statements.find(node => node.name?.getText() === name || (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText() === name)));
    if (!actual || tokens(actual.getText().replace(/^export /, "")) !== tokens(expected.getText().replace(/^export /, ""))) throw new Error(`Changed helper: ${name}`);
  }
  const clearTiming = inbound.members.find(node => node.name?.getText() === "clearAdmissionTiming");
  const clearPrompts = inbound.members.find(node => node.name?.getText() === "clearPendingPrompts");
  if (!clearTiming || !clearPrompts) throw new Error("Missing ordered lifecycle cleanup");
  const cleanupBody = node => node.body.getText().slice(1, -1);
  const undoCaller = text => text.replaceAll("this.inboundTurns.clearAdmissionTiming();", cleanupBody(clearTiming))
    .replaceAll("this.inboundTurns.clearPendingPrompts();", cleanupBody(clearPrompts))
    .replaceAll("this.inboundTurns.", "this.").replaceAll("readController().inboundTurns.", "readController().");
  for (const method of owner.members.filter(node => ts.isMethodDeclaration(node) && !names.includes(node.name.getText()))) {
    const actual = facade.members.find(node => node.name?.getText() === method.name.getText());
    if (!actual || tokens(undoCaller(actual.getText())) !== tokens(method.getText())) throw new Error(`Changed retained caller or cleanup order: ${method.name.getText()}`);
  }
  for (const field of owner.members.filter(ts.isPropertyDeclaration)) {
    const name = field.name.getText();
    const actual = (fields.includes(name) ? inbound : facade).members.find(node => node.name?.getText() === name);
    if (!actual || tokens(actual.getText()) !== tokens(fields.includes(name) ? field.getText().replace(/^private /, "") : field.getText())) throw new Error(`Changed field: ${name}`);
    if (fields.includes(name) && facade.members.some(node => node.name?.getText() === name)) throw new Error(`Duplicate field owner: ${name}`);
  }
  const construction = facade.members.find(ts.isConstructorDeclaration);
  const factory = construction.body.statements.find(statement => ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.left.getText() === "this.inboundTurns");
  const reader = construction.body.statements.find(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText() === "readInboundConfig"));
  if (!factory || !reader || tokens(reader.getText()) !== tokens("const readInboundConfig = () => this.options;")) throw new Error("Missing lazy inbound configuration");
  const retained = construction.body.statements.filter(statement => statement !== factory && statement !== reader).map(statement => undoCaller(statement.getText())).join("\n");
  if (tokens(`{${retained}}`) !== tokens(owner.members.find(ts.isConstructorDeclaration).body.getText())) throw new Error("Changed retained construction order");
  const context = factory.expression.right.arguments[0];
  for (const [name, reader] of Object.entries({ store: "readStore", backend: "readBackend", adapter: "readAdapter", capabilityProfile: "readCapabilityProfile", logger: "readLogger", config: "readInboundConfig" })) {
    const accessor = context.properties.find(property => property.name?.getText() === name);
    if (!accessor || !ts.isGetAccessor(accessor) || tokens(accessor.body.getText()) !== tokens(`{ return ${reader}(); }`)) throw new Error(`Captured inbound collaborator: ${name}`);
  }
  const clock = context.properties.find(property => property.name?.getText() === "now");
  if (!clock || tokens(clock.getText()) !== tokens("now: () => this.now()")) throw new Error("Changed native clock receiver");
  const hostMethod = facade.members.find(node => node.name?.getText() === "inboundHost");
  for (const [name, record] of host) {
    const expected = record.kind === "method" ? `${name}: (...args) => this.${name}(...args)` : `get ${name}() { return readController().${name}; }`;
    if (!hostMethod?.getText().includes(expected)) throw new Error(`Changed host port: ${name}`);
  }
  for (const helper of source.statements.filter(node => ts.isFunctionDeclaration(node) && !globals.has(node.name.text))) {
    const actual = current.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.getText() === helper.name.text);
    if (!actual || tokens(actual.getText()) !== tokens(helper.getText())) throw new Error(`Changed retained helper: ${helper.name.text}`);
  }
  for (const module of [moved, helpers]) if (module.statements.filter(ts.isImportDeclaration).some(node => node.moduleSpecifier.text.includes("messaging-controller"))) throw new Error("Owner imports its facade");
}
console.log(JSON.stringify({ baseline, methods: methods.length, fields: fields.length, globals: globals.size, hostPorts: host.size, broadSeams: seams.length, resolvedReferences: references.length, effects: effects.length, methodLines: methods.reduce((sum, node) => sum + node.getText().split("\n").length, 0), helperLines: [...globals.values()].reduce((sum, node) => sum + node.getText().split("\n").length, 0), verified: process.argv.includes("--verify") }));
