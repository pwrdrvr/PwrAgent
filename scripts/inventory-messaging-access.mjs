import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import path from "node:path";

const baseline = "709b770acae5cc800b78074f41b5180e3219bfa0";
const file = "apps/desktop/src/main/messaging/core/messaging-controller.ts";
const directory = ".local/pwr-149-access/inventory";
const names = ["isAuthorized", "resolveActorPermissions", "authorizeInboundAdmission", "requirePermission", "requireRemoteScope", "actorHasPermission", "requireRemoteScopeForBinding", "recordCapabilityDenied", "deliverCapabilityDenied", "checkDynamicToolPermission", "ensureFullAccessEscalationAllowed", "presentFullAccessRiskWarning", "canResumeFullAccessThreads", "resolveFullAccessRiskForSession", "resolveFullAccessControls", "resolveFullAccessWarning", "deliverFullAccessPolicyError", "recordFullAccessPolicyViolation", "retainedRequestSource", "retainedRequestCanCrossInstance", "retainedSourceIsAuthorized", "retainedSourceHasPermissions", "authorizeRetainedTool", "updateAuthorizedActorIds", "monitorAuthorizedActorIds"];
const fields = ["authorizedActorIds"];
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
writeFileSync(`${directory}/access.json`, `${JSON.stringify(report, null, 2)}\n`);
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
console.log(JSON.stringify({ baseline, methods: methods.length, fields: fields.length, globals: globals.size, hostPorts: host.size, broadSeams: seams.length, resolvedReferences: references.length, effects: effects.length, ports: report.ports, options: report.options }));
if (process.argv.includes("--verify")) {
  const parse = name => ts.createSourceFile(name, readFileSync(name, "utf8"), ts.ScriptTarget.Latest, true);
  const current = parse(file);
  const facade = current.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingController");
  const moved = parse("apps/desktop/src/main/messaging/core/messaging-access-control.ts");
  const access = moved.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingAccessControl");
  const helpers = parse("apps/desktop/src/main/messaging/core/messaging-access-helpers.ts");
  const publicCalls = { checkDynamicToolPermission: "params, source", authorizeRetainedTool: "context, check", updateAuthorizedActorIds: "actorIds" };
  const undo = text => text.replaceAll("this.context.host().", "this.")
    .replaceAll("this.context.store", "this.options.store").replaceAll("this.context.config.", "this.options.")
    .replaceAll("this.context.now", "this.now").replaceAll("this.context.capabilityProfile", "this.capabilityProfile")
    .replaceAll("this.context.adapter", "this.adapter").replaceAll("this.context.logger", "this.logger")
    .replaceAll('Parameters<MessagingAccessControl["checkDynamicToolPermission"]>', 'Parameters<MessagingController["checkDynamicToolPermission"]>');
  const undoCaller = text => text.replaceAll("this.accessControl.", "this.").replaceAll("readController().accessControl.", "readController().");
  for (const method of methods) {
    const name = method.name.getText();
    const actual = access.members.find(node => node.name?.getText() === name);
    if (!actual || tokens(undo(actual.getText())) !== tokens(method.getText().replace(/^private /, ""))) throw new Error(`Changed access signature or effects: ${name}`);
    const wrapper = facade.members.find(node => node.name?.getText() === name);
    if (name in publicCalls) {
      const signature = method.getText().slice(0, method.body.pos - method.getStart());
      const expected = signature + `{ ${name === "updateAuthorizedActorIds" ? "" : "return "}this.accessControl.${name}(${publicCalls[name]}); }`;
      if (!wrapper || tokens(wrapper.getText()) !== tokens(expected)) throw new Error(`Changed public facade port: ${name}`);
    } else if (wrapper) throw new Error(`Obsolete private facade operation: ${name}`);
  }
  for (const method of owner.members.filter(node => ts.isMethodDeclaration(node) && !names.includes(node.name.getText()))) {
    const actual = facade.members.find(node => node.name?.getText() === method.name.getText());
    if (!actual || tokens(undoCaller(actual.getText())) !== tokens(method.getText())) throw new Error(`Changed retained caller: ${method.name.getText()}`);
  }
  for (const accessor of owner.members.filter(node => ts.isGetAccessor(node) || ts.isSetAccessor(node))) {
    const actual = facade.members.find(node => node.kind === accessor.kind && node.name?.getText() === accessor.name.getText());
    if (!actual || tokens(undoCaller(actual.getText())) !== tokens(accessor.getText())) throw new Error(`Changed retained accessor: ${accessor.name.getText()}`);
  }
  for (const [name, expected] of globals) {
    const actual = helpers.statements.find(node => node.name?.getText() === name);
    if (!actual || tokens(actual.getText().replace(/^export /, "")) !== tokens(expected.getText().replace(/^export /, ""))) throw new Error(`Changed access helper: ${name}`);
  }
  for (const field of owner.members.filter(ts.isPropertyDeclaration)) {
    const name = field.name.getText();
    const actual = (fields.includes(name) ? access : facade).members.find(node => node.name?.getText() === name);
    if (!actual || tokens(actual.getText()) !== tokens(field.getText())) throw new Error(`Changed field owner: ${name}`);
    if (fields.includes(name) && facade.members.some(node => node.name?.getText() === name)) throw new Error(`Duplicate state: ${name}`);
  }
  const construction = facade.members.find(ts.isConstructorDeclaration);
  const factory = construction.body.statements.find(statement => ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.left.getText() === "this.accessControl");
  const reader = construction.body.statements.find(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText() === "readAccessConfig"));
  if (!factory || !reader || tokens(reader.getText()) !== tokens("const readAccessConfig = () => this.options;")) throw new Error("Missing lazy access configuration");
  const retained = construction.body.statements.filter(statement => statement !== reader).map(statement => statement === factory
    ? "this.authorizedActorIds = new Set(options.authorizedActorIds);" : undoCaller(statement.getText())).join("\n");
  if (tokens(`{${retained}}`) !== tokens(owner.members.find(ts.isConstructorDeclaration).body.getText())) throw new Error("Changed construction order");
  const context = factory.expression.right.arguments[0];
  for (const [name, reader] of Object.entries({ store: "readStore", adapter: "readAdapter", capabilityProfile: "readCapabilityProfile", logger: "readLogger", config: "readAccessConfig" })) {
    const accessor = context.properties.find(property => property.name?.getText() === name);
    if (!accessor || !ts.isGetAccessor(accessor) || tokens(accessor.body.getText()) !== tokens(`{ return ${reader}(); }`)) throw new Error(`Captured access collaborator: ${name}`);
  }
  if (tokens(context.properties.find(property => property.name?.getText() === "now")?.getText() ?? "") !== tokens("now: () => this.now()")) throw new Error("Changed clock receiver");
  if (tokens(context.properties.find(property => property.name?.getText() === "host")?.getText() ?? "") !== tokens("host: () => this.accessHost()")) throw new Error("Captured access host");
  const ownerConstructor = access.members.find(ts.isConstructorDeclaration);
  if (tokens(ownerConstructor.body.getText()) !== tokens("{ this.authorizedActorIds = new Set(actorIds); }")) throw new Error("Access construction reads live collaborators");
  const hostMethod = facade.members.find(node => node.name?.getText() === "accessHost");
  const portsFile = parse("apps/desktop/src/main/messaging/core/messaging-access-context.ts");
  const hostInterface = portsFile.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === "MessagingAccessHost");
  for (const [name, record] of host) {
    const expected = record.kind === "method" ? `${name}: (...args) => this.${name}(...args)` : `get ${name}() { return readController().${name}; }`;
    if (!hostMethod?.getText().includes(expected)) throw new Error(`Changed access host port: ${name}`);
    const signature = name === "activeAgentMessagingOriginsByTurnKey"
      ? 'Pick<ReadonlyMap<string, Pick<ActiveAgentMessagingOrigin, "event" | "source">>, "get">'
      : record.type;
    const member = hostInterface?.members.find(node => node.name?.getText() === name);
    if (!member || tokens(member.getText()) !== tokens(`readonly ${name}: ${signature};`)) throw new Error(`Changed access host signature: ${name}`);
  }
  for (const helper of source.statements.filter(node => ts.isFunctionDeclaration(node) && !globals.has(node.name.text))) {
    const actual = current.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.getText() === helper.name.text);
    if (!actual || tokens(actual.getText()) !== tokens(helper.getText())) throw new Error(`Changed retained helper: ${helper.name.text}`);
  }
  for (const module of [moved, helpers, parse("apps/desktop/src/main/messaging/core/messaging-access-context.ts")]) if (module.statements.filter(ts.isImportDeclaration).some(node => node.moduleSpecifier.text.includes("messaging-controller"))) throw new Error("Access module imports facade");
  console.log(JSON.stringify({ verified: true, methods: methods.length, fields: fields.length, helpers: globals.size, hostPorts: host.size }));
}
