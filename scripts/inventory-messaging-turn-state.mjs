import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const baseline = "a473f7b70baf2ae2e7bcbecb4a27be5b9e7852b9";
const core = "apps/desktop/src/main/messaging/core/";
const facadePath = `${core}messaging-controller.ts`;
const routerPath = `${core}messaging-backend-event-router.ts`;
const inboundPath = `${core}messaging-inbound-turns.ts`;
const statePath = `${core}messaging-turn-state.ts`;
const directory = ".local/pwr-149-turn-state/inventory";
const fields = ["activeTurnsByThreadKey", "queuedTurnDrainRequests", "queuedTurnDrainTimers", "queuedTurnDrains"];
const selected = new Set([...fields, "getActiveTurn", "setActiveTurn", "scheduleNextQueuedTurn", "startNextQueuedTurn", "steerQueuedTurn",
  "submitQueuedTurnSteer", "resolveMonitorActiveTurns", "dispose", "whenQueuedTurnDrainsSettled", "handleBackendEventNow", "startPreparedInput"]);
const old = file => execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const config = ts.readConfigFile("apps/desktop/tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, "apps/desktop");
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();
const source = name => ts.createSourceFile(name, readFileSync(name, "utf8"), ts.ScriptTarget.Latest, true);
const owner = (file, name) => file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
const member = (value, name) => value.members.find(node => node.name?.getText() === name);
const location = node => { const file = node.getSourceFile(); return { file: file.fileName, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 }; };
const parents = (node, predicate) => { const result = []; for (let p = node.parent; p; p = p.parent) if (predicate(p)) result.push(location(p)); return result; };
const effects = [], references = [], seams = [];
for (const file of program.getSourceFiles()) {
  if (file.isDeclarationFile || file.fileName.includes("node_modules")) continue;
  const visit = node => {
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (name && selected.has(name)) references.push({ ...location(node), name, declarations: checker.getSymbolAtLocation(node)?.declarations?.map(location) });
    const currentOwner = parents(node, node => ts.isMethodDeclaration(node) && selected.has(node.name.getText()));
    if ([facadePath, routerPath, inboundPath, statePath].some(path => file.fileName.endsWith(path)) && (currentOwner.length || file.fileName.endsWith(statePath))) {
      const kind = ts.isCallExpression(node) ? "call" : ts.isAwaitExpression(node) ? "await" : ts.isReturnStatement(node) ? "return"
        : ts.isThrowStatement(node) ? "throw" : ts.isTryStatement(node) ? "exception-boundary"
        : ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node) ? "branch"
        : ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? "mutation"
        : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? "read" : undefined;
      if (kind) effects.push({ ...location(node), kind, text: node.getText(), type: checker.typeToString(checker.getTypeAtLocation(node)),
        branches: parents(node, node => ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isSwitchStatement(node)), catches: parents(node, ts.isTryStatement) });
    }
    if (file.fileName.includes("__tests__") && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isCallExpression(node) && /spyOn|Object\.(assign|create|setPrototypeOf)/.test(node.expression.getText())
      || ts.isPropertyAccessExpression(node) && node.name.text === "prototype" || ts.isObjectLiteralExpression(node))) {
      const text = node.getText();
      if ([...selected, "MessagingTurns", "MessagingController"].some(name => text.includes(name))) seams.push({ ...location(node), kind: ts.SyntaxKind[node.kind], text,
        members: checker.getPropertiesOfType(checker.getTypeAtLocation(node)).map(symbol => symbol.name) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/audit.json`, JSON.stringify({ baseline, fields, effects, references, seams }, null, 2) + "\n");
const tokens = text => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) result.push(scanner.getTokenText());
  return JSON.stringify(result);
};
const assertEqual = (name, before, after) => { if (tokens(before) !== tokens(after)) throw new Error(`Changed effects/signature: ${name}`); };
if (process.argv.includes("--verify")) {
  const before = owner(ts.createSourceFile(facadePath, old(facadePath), ts.ScriptTarget.Latest, true), "MessagingController");
  const after = owner(source(facadePath), "MessagingController");
  for (const name of fields) if (member(after, name)) throw new Error(`Obsolete facade state: ${name}`);
  const beforeConstructor = before.members.find(ts.isConstructorDeclaration).getText();
  const afterConstructor = after.members.find(ts.isConstructorDeclaration).getText();
  const wiring = `    const readTurnAdmission = () => this.turnAdmission;
    this.turns = new MessagingTurns({
      get logger() { return readLogger(); },
      host: () => ({
        get turnAdmission() { return readTurnAdmission(); },
        startNextQueuedTurn: (...args) => this.startNextQueuedTurn(...args),
      }),
    });
`;
  if (!afterConstructor.includes(wiring)) throw new Error("Changed lazy turn-state construction ports");
  assertEqual("constructor order and remaining wiring", beforeConstructor, afterConstructor.replace(wiring, ""));
  const oldTimerCleanup = `for (const { timer, settle } of this.queuedTurnDrainTimers.values()) {
      clearTimeout(timer);
      settle();
    }
    this.queuedTurnDrainTimers.clear();`;
  const restoredDispose = member(after, "dispose").getText().replace("this.turns.dispose();", oldTimerCleanup)
    .replace("this.sharedQueueNoticeHistory.clear();", "this.sharedQueueNoticeHistory.clear();\n    this.queuedTurnDrainRequests.clear();");
  assertEqual("dispose boundaries and order", member(before, "dispose").getText(), restoredDispose);
  const special = new Set([...fields, "constructor", "scheduleNextQueuedTurn", "getActiveTurn", "setActiveTurn", "dispose", "whenQueuedTurnDrainsSettled"]);
  for (const node of before.members) {
    const name = node.name?.getText() ?? "constructor";
    if (special.has(name)) continue;
    const actual = member(after, name);
    if (!actual) throw new Error(`Lost facade member: ${name}`);
    const restored = actual.getText().replaceAll("this.turns.takeDrainRequest(", "this.queuedTurnDrainRequests.delete(")
      .replaceAll("this.turns.requestDrain(", "this.queuedTurnDrainRequests.add(")
      .replaceAll("new Map(this.turns.snapshot())", "new Map(this.activeTurnsByThreadKey)")
      .replace("acceptStartedTurn: (...args) => this.turns.accept(...args),", "")
      .replace("observeBackendTurn: (...args) => this.turns.observeBackend(...args),", "");
    assertEqual(name, node.getText(), restored);
  }
  for (const [name, body] of [["scheduleNextQueuedTurn", "this.turns.schedule(binding);"], ["getActiveTurn", "return this.turns.get(binding);"],
    ["setActiveTurn", "this.turns.observe(binding, activeTurn);"], ["whenQueuedTurnDrainsSettled", "await this.turns.whenDrainsSettled();"]]) {
    assertEqual(name, `{ ${body} }`, member(after, name).body.getText());
  }
  const oldRouter = owner(ts.createSourceFile(routerPath, old(routerPath), ts.ScriptTarget.Latest, true), "MessagingBackendEventRouter");
  const newRouter = owner(source(routerPath), "MessagingBackendEventRouter");
  const oldBody = member(oldRouter, "handleBackendEventNow").getText();
  const newBody = member(newRouter, "handleBackendEventNow").getText();
  const oldStart = oldBody.indexOf("      if (lifecycle && !automationTurnEvent) {");
  const oldEnd = oldBody.indexOf("\n      const terminalPrivateResponse", oldStart);
  const newStart = newBody.indexOf("      const observation =");
  const newEnd = newBody.indexOf("\n      const terminalPrivateResponse", newStart);
  if ([oldStart, oldEnd, newStart, newEnd].some(index => index < 0)) throw new Error("Missing lifecycle extraction boundary");
  assertEqual("router lifecycle caller surroundings", oldBody, newBody.slice(0, newStart) + oldBody.slice(oldStart, oldEnd) + newBody.slice(newEnd));
  const oldInbound = owner(ts.createSourceFile(inboundPath, old(inboundPath), ts.ScriptTarget.Latest, true), "MessagingInboundTurns");
  const newInbound = owner(source(inboundPath), "MessagingInboundTurns");
  for (const node of oldInbound.members) {
    const actual = ts.isConstructorDeclaration(node) ? newInbound.members.find(ts.isConstructorDeclaration) : member(newInbound, node.name?.getText() ?? "");
    assertEqual(`inbound ${node.name?.getText() ?? "constructor"}`, node.getText(), actual?.getText().replaceAll(".acceptStartedTurn(", ".setActiveTurn(") ?? "");
  }
  const stateSource = source(statePath);
  if (stateSource.parseDiagnostics.length) throw new Error("Invalid state module");
  if (/from ["'].*messaging-controller/.test(stateSource.text)) throw new Error("State imports its facade");
}
console.log(JSON.stringify({ baseline, effects: effects.length, references: references.length, seams: seams.length, retiredFields: fields.length, verified: process.argv.includes("--verify") }));
