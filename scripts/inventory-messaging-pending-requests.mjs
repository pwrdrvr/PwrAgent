import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const baseline = "d4e7a215b4edaeeb9847ab8d673693612dbee107";
const file = "apps/desktop/src/main/messaging/core/messaging-controller.ts";
const directory = ".local/pwr-149-pending-requests/inventory";
const current = process.argv.includes("--current");
if (current && process.argv.includes("--verify")) throw new Error("Run --verify and --current separately");
const names = ["handleBackendPendingRequest", "presentBackendPendingRequest", "handleQuestionnaireTextAnswer", "handleQuestionnaireAction", "questionnaireWithOptionAnswer", "questionnaireWithRecordedAnswer", "questionnaireWithNextQuestion", "questionnaireReadyToSubmit", "submitAndRetireQuestionnaire", "questionnaireWithPreviousQuestion", "updateQuestionnairePendingIntent", "deliverQuestionnaireIntent", "deliverAsyncQuestionnaire", "submitAsyncQuestionnaire", "sendAsyncQuestionReply", "retireAnsweredAsyncQuestionnaires", "submitQuestionnaireIntent", "submitApprovalAction", "handleBackendRequestResolved", "retireApprovalIntent", "resumeBindingForPendingIntent", "retireStalePendingIntent", "intentForPendingRequest"];
const sharedHelpers = ["approvalBodyWithResponse", "questionnaireAnswerValue"];
const seamNames = [...names, "pendingRequests", "pendingRequestHost", "pendingRequestPresentations"];
const original = execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const config = ts.readConfigFile("apps/desktop/tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, "apps/desktop");
const compilerHost = ts.createCompilerHost(parsed.options);
const read = compilerHost.readFile.bind(compilerHost);
compilerHost.readFile = name => !current && path.resolve(name) === path.resolve(file) ? original : read(name);
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true }, compilerHost);
const checker = program.getTypeChecker();
const source = program.getSourceFile(current ? "apps/desktop/src/main/messaging/core/messaging-pending-request-workflow.ts" : file);
const owner = source.statements.find(node => ts.isClassDeclaration(node)
  && node.name?.text === (current ? "MessagingPendingRequestWorkflow" : "MessagingController"));
const methods = names.map(name => owner.members.find(node => node.name?.getText() === name));
if (methods.some(method => !method)) throw new Error("Missing baseline pending-request operation");
const globals = new Map();
const collectGlobals = node => {
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    for (const declaration of resolved?.declarations ?? []) {
      const topLevel = (declaration.parent === source || sharedHelpers.includes(declaration.name?.getText())) && (ts.isFunctionDeclaration(declaration)
        || ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration));
      const variable = ts.isVariableDeclaration(declaration) && ts.isVariableStatement(declaration.parent.parent)
        && (declaration.parent.parent.parent === source || sharedHelpers.includes(declaration.name?.getText())) ? declaration.parent.parent : undefined;
      const global = topLevel ? declaration : variable;
      if (global && !globals.has(declaration.name.getText())) {
        globals.set(declaration.name.getText(), global);
        collectGlobals(global);
      }
    }
  }
  ts.forEachChild(node, collectGlobals);
};
methods.forEach(collectGlobals);
const where = node => ({ file: node.getSourceFile().fileName,
  line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 });
const host = new Map();
const ports = { store: new Set(), backend: new Set() };
const effects = [], references = [], seams = [], dependencies = new Set();
const inside = node => [...methods, ...globals.values()].some(method => node.getSourceFile() === method.getSourceFile()
  && node.pos >= method.pos && node.end <= method.end);
for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile || sourceFile.fileName.includes("node_modules")
    || !seamNames.some(name => sourceFile.text.includes(name)) && !sourceFile.fileName.endsWith("messaging-pending-request-harness.ts") && sourceFile !== source) continue;
  const test = sourceFile.fileName.includes("__tests__")
    && (seamNames.some(name => sourceFile.text.includes(name)) || sourceFile.fileName.endsWith("messaging-pending-request-harness.ts"));
  const visit = node => {
    if (ts.isIdentifier(node) && names.includes(node.text)) {
      const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
      if (declarations.some(declaration => methods.includes(declaration))) references.push({ ...where(node), name: node.text });
    }
    if (inside(node)) {
      if (ts.isPropertyAccessExpression(node) && (current ? node.expression.getText() === "this.context.host()"
        : (node.expression.kind === ts.SyntaxKind.ThisKeyword && !names.includes(node.name.text)
          && !["options", "now", "capabilityProfile", "logger", "bindingService", "accessControl", "inboundTurns", "pendingRequestPresentations"].includes(node.name.text)
          || ["this.bindingService", "this.accessControl", "this.inboundTurns"].includes(node.expression.getText())))) {
        host.set(node.name.text, { ...where(node), type: checker.typeToString(checker.getTypeAtLocation(node), node,
          ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope) });
      }
      if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && (current ? /^this\.context\.(store|backend)$/ : /^this\.options\.(store|backend)$/).test(node.expression.getText())) ports[node.expression.name.text].add(node.name.text);
      if (ts.isIdentifier(node)) dependencies.add(node.text);
      const kind = ts.isCallExpression(node) ? "call" : ts.isAwaitExpression(node) ? "await"
        : ts.isReturnStatement(node) ? "return" : ts.isThrowStatement(node) ? "throw" : ts.isTryStatement(node) ? "exception-boundary"
        : ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node) ? "branch"
        : ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? "mutation"
        : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? "read" : undefined;
      if (kind) {
        const boundaries = [];
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isTryStatement(parent) || ts.isIfStatement(parent)) boundaries.push(where(parent));
        }
        effects.push({ ...where(node), kind, text: node.getText(), boundaries,
          mutation: ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && ["set", "add", "delete", "clear", "push", "splice", "shift", "unshift"].includes(node.expression.name.text) });
      }
    }
    if (test) {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const type = checker.getTypeAtLocation(node);
        let receiver = node.expression;
        while (ts.isAsExpression(receiver) || ts.isTypeAssertionExpression(receiver)) receiver = receiver.expression;
        seams.push({ ...where(node), kind: "cast", text: node.getText(),
          members: checker.getPropertiesOfType(type).map(property => property.name),
          receiverType: checker.typeToString(checker.getTypeAtLocation(receiver), receiver, ts.TypeFormatFlags.NoTruncation),
          namedType: type.aliasSymbol?.declarations?.map(declaration => ({ ...where(declaration), text: declaration.getText() })) });
      }
      if ((ts.isCallExpression(node) && /spyOn|Object\.(assign|create|definePropert(?:y|ies)|setPrototypeOf)/.test(node.expression.getText())
        || ts.isBinaryExpression(node) && /prototype|\.\w+\s*=/.test(node.getText()))
        ) seams.push({ ...where(node), kind: "override", text: node.getText() });
      if (ts.isObjectLiteralExpression(node) && node.properties.some(property => property.name
        && seamNames.includes(property.name.getText().replaceAll('"', "")))) seams.push({ ...where(node), kind: "stand-in", text: node.getText() });
      if (ts.isNewExpression(node) && node.expression.getText() === "MessagingPendingRequestWorkflow") {
        seams.push({ ...where(node), kind: "owner-construction", text: node.getText() });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
const imports = source.statements.filter(ts.isImportDeclaration).map(node => ({ text: node.getText(),
  defaultUsed: node.importClause?.name && dependencies.has(node.importClause.name.text),
  used: node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    ? node.importClause.namedBindings.elements.filter(element => dependencies.has(element.name.text)).map(element => element.name.text) : [] }));
const facadeSource = program.getSourceFile(file);
const facadeClass = facadeSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingController");
const report = { baseline, current, names, methods: methods.map(node => ({ ...where(node), name: node.name.getText(), text: node.getText() })),
  globals: [...globals].map(([name, node]) => ({ ...where(node), name, text: node.getText() })),
  host: Object.fromEntries(host), ports: Object.fromEntries(Object.entries(ports).map(([name, values]) => [name, [...values]])),
  imports, effects, references, seams,
  constructor: owner.members.find(ts.isConstructorDeclaration)?.getText(),
  facadeConstructor: facadeClass.members.find(ts.isConstructorDeclaration)?.getText(),
  stateFields: owner.members.filter(ts.isPropertyDeclaration).map(node => ({ ...where(node), text: node.getText() })) };
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/${current ? "current" : "original"}.json`, JSON.stringify(report, null, 2) + "\n");
const tokens = text => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) result.push(scanner.getTokenText());
  return JSON.stringify(result);
};
if (process.argv.includes("--verify")) {
  // Resolve named structural casts as well as inline casts. A retained public
  // entry point is allowed; moved private operations must not stay on a facade.
  for (const seam of seams.filter(seam => seam.kind === "cast" && seam.receiverType === "MessagingController")) {
    const declarations = [seam.text, ...(seam.namedType ?? []).map(item => item.text)].join("\n");
    const obsolete = names.filter(name => name !== "handleBackendPendingRequest" && seam.members.includes(name)
      && new RegExp("\\b" + name + "\\b").test(declarations));
    if (obsolete.length) throw new Error(`Obsolete facade cast at ${seam.file}:${seam.line}: ${obsolete.join(", ")}`);
  }
  const facadeSource = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const facade = facadeSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingController");
  const moved = ts.createSourceFile("monitor.ts", readFileSync("apps/desktop/src/main/messaging/core/messaging-pending-request-workflow.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const workflow = moved.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MessagingPendingRequestWorkflow");
  const helpers = ts.createSourceFile("helpers.ts", readFileSync("apps/desktop/src/main/messaging/core/messaging-pending-request-helpers.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const undo = text => text.replaceAll("this.context.host().renderAutomaticBindingStatus", "this.bindingService.renderAutomaticBindingStatus")
    .replaceAll("this.context.host().requirePermission", "this.accessControl.requirePermission")
    .replaceAll("this.context.host().requireRemoteScopeForBinding", "this.accessControl.requireRemoteScopeForBinding")
    .replaceAll("this.context.host().isTurnOccupied", "this.inboundTurns.isTurnOccupied")
    .replaceAll("this.context.host().startPreparedInput", "this.inboundTurns.startPreparedInput")
    .replaceAll("this.context.host().", "this.").replaceAll("this.context.store", "this.options.store")
    .replaceAll("this.context.backend", "this.options.backend").replaceAll("this.context.", "this.");
  for (const method of methods) {
    const name = method.name.getText();
    const actual = workflow.members.find(node => node.name?.getText() === name);
    if (!actual || tokens(undo(actual.body.getText())) !== tokens(method.body.getText())) throw new Error(`Changed pending-request effects: ${name}`);
    const retained = facade.members.find(node => node.name?.getText() === name);
    if (name === "handleBackendPendingRequest") {
      if (!retained || tokens(retained.body.getText()) !== tokens("{ await this.pendingRequests.handleBackendPendingRequest(backend, request, federationTarget); }")) throw new Error("Changed facade pending-request routing");
    } else if (retained) throw new Error(`Obsolete facade operation: ${name}`);
  }
  const field = "pendingRequestPresentations";
  const originalField = owner.members.find(node => node.name?.getText() === field);
  const actualField = workflow.members.find(node => node.name?.getText() === field);
  if (!actualField || tokens(actualField.getText()) !== tokens(originalField.getText()) || facade.members.some(node => node.name?.getText() === field)) throw new Error("Changed presentation reservation ownership");
  for (const method of owner.members.filter(node => ts.isMethodDeclaration(node) && !names.includes(node.name.getText()))) {
    const actual = facade.members.find(node => node.name?.getText() === method.name.getText());
    if (!actual || tokens(actual.getText().replaceAll("this.pendingRequests.", "this.")
      .replaceAll("MessagingPendingRequestWorkflow[", "MessagingController[")) !== tokens(method.getText())) throw new Error(`Changed retained caller: ${method.name.getText()}`);
  }
  for (const [name, original] of globals) {
    const actual = helpers.statements.find(node => node.name?.getText() === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText() === name));
    if (!actual || tokens(actual.getText().replace(/^export /, "")) !== tokens(original.getText())) throw new Error(`Changed pending-request helper: ${name}`);
  }
}

console.log(JSON.stringify({ baseline, current, methods: methods.length, globals: globals.size, hostPorts: host.size, ports: report.ports,
  references: references.length, seams: seams.length, effects: effects.length, syntaxFailures: program.getSyntacticDiagnostics().length,
  verified: process.argv.includes("--verify") }));
