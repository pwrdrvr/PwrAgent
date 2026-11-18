import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const baseline = "b13f0692db35f2809585e07aabc420c0abb7759d";
const root = "apps/desktop/src/main/messaging/core/";
const production = ["messaging-turn-admission.ts", "messaging-turn-state.ts", "messaging-controller.ts",
  "messaging-callback-handlers.ts", "messaging-callback-context.ts", "messaging-inbound-turns.ts",
  "messaging-inbound-context.ts", "messaging-backend-event-router.ts", "messaging-backend-event-context.ts"].map(file => root + file);
const auditPaths = [...production, `${root}messaging-queue-recoveries.ts`,
  "apps/desktop/src/main/messaging/desktop-backend-bridge.ts", "packages/owner-core/src/thread-turn-queue.ts"];
const selected = new Set(["queuedByThreadKey", "turnAdmission", "queueRecoveries", "MessagingQueueRecoveries", "submitTurn", "releaseThread", "scheduleDrain", "settleRelease", "startNext", "startEntry", "readQueuedTurn", "cancelQueuedTurn", "queuePreparedInput", "startPreparedInput", "handleAdmittedTurnBundle",
  "sendAsyncQuestionReply", "handleQueuedTurnCallback", "handleSharedQueuedTurnCallback", "deliverQueuedTurnNotice",
  "retireQueuedTurnNotice", "applySharedQueueNoticeEvent", "startNextQueuedTurn", "scheduleNextQueuedTurn", "steerQueuedTurn",
  "submitQueuedTurnSteer", "ownsTurnQueue", "queueOnConcurrentStart", "enqueue", "findQueuedEntry", "updateQueuedEntry",
  "removeQueuedEntry", "peekNextQueued", "shiftNextQueued", "requestDrain", "takeDrainRequest", "isStarting", "dispose"]);
const config = ts.readConfigFile("apps/desktop/tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, "apps/desktop");
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();
const loc = node => ({ file: node.getSourceFile().fileName,
  line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 });
const ancestors = (node, predicate) => { const result = []; for (let p = node.parent; p; p = p.parent) if (predicate(p)) result.push(loc(p)); return result; };
const effects = [], references = [], seams = [], ports = [];
for (const file of program.getSourceFiles()) {
  if (file.isDeclarationFile || file.fileName.includes("node_modules")) continue;
  const visit = node => {
    const text = () => node.getText();
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (name && selected.has(name)) references.push({ ...loc(node), name,
      declarations: checker.getSymbolAtLocation(node)?.declarations?.map(loc) });
    if (auditPaths.some(path => file.fileName.endsWith(path)) || file.fileName.endsWith("/backend-registry.ts")
      && ancestors(node, n => ts.isMethodDeclaration(n) && ["submitTurn", "readQueuedTurn", "cancelQueuedTurnWithDisposition"].includes(n.name.getText())).length) {
      const kind = ts.isCallExpression(node) ? "call" : ts.isAwaitExpression(node) ? "await"
        : ts.isReturnStatement(node) ? "return" : ts.isThrowStatement(node) ? "throw"
        : ts.isTryStatement(node) ? "exception-boundary" : ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node) ? "branch"
        : ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? "mutation"
        : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? "read" : undefined;
      if (kind) effects.push({ ...loc(node), kind, text: text(), type: checker.typeToString(checker.getTypeAtLocation(node)),
        branches: ancestors(node, n => ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isSwitchStatement(n)), catches: ancestors(node, ts.isTryStatement) });
      if (ts.isPropertySignature(node) || ts.isGetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) ports.push({ ...loc(node), text: text(), type: checker.typeToString(checker.getTypeAtLocation(node)) });
    }
    if (file.fileName.includes("__tests__") && /messaging|registry|desktop-backend-bridge/.test(file.fileName.split("/").at(-1)) && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isObjectLiteralExpression(node)
      || ts.isCallExpression(node) && /spyOn|Object\.(assign|create|setPrototypeOf)/.test(node.expression.getText())
      || ts.isPropertyAccessExpression(node) && node.name.text === "prototype")) {
      if ([...selected, "MessagingController", "MessagingTurns", "MessagingTurnAdmission"].some(name => text().includes(name))
        || (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
          && checker.getPropertiesOfType(checker.getTypeAtLocation(node)).some(symbol => selected.has(symbol.name))) {
        seams.push({ ...loc(node), kind: ts.SyntaxKind[node.kind], text: text(), members: checker.getPropertiesOfType(checker.getTypeAtLocation(node)).map(symbol => symbol.name) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
const directory = ".local/pwr-149-canonical-queue/inventory";
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/audit.json`, JSON.stringify({ baseline, effects, references, seams, ports }, null, 2) + "\n");
// Preserve the actual pre-change production source alongside checker evidence.
for (const file of production) writeFileSync(`${directory}/${file.split("/").at(-1)}.baseline`, execFileSync("git", ["show", `${baseline}:${file}`]));
if (process.argv.includes("--verify")) {
  for (const file of production) {
    const source = readFileSync(file, "utf8");
    for (const retired of ["queuedByThreadKey", "peekNextQueued", "shiftNextQueued", "queuePreparedInput", "queueOnConcurrentStart", "startNextQueuedTurn", "scheduleNextQueuedTurn"]) {
      if (source.includes(retired)) throw new Error(`${file}: obsolete queue ownership ${retired}`);
    }
  }
  const allowed = {
    "messaging-controller.ts": ["constructor", "queueRecoveries", "inboundHost", "callbackHost", "backendEventHost", "handleBackendPendingRequest", "presentBackendPendingRequest",
      "deliverQueuedTurnNotice", "steerQueuedTurn", "submitQueuedTurnSteer", "scheduleNextQueuedTurn", "startNextQueuedTurn", "sendAsyncQuestionReply",
      "dispose", "whenToolUpdatesSettled", "whenQueuedTurnDrainsSettled", "reconcileIdleTurnAndStartNext"],
    "messaging-callback-handlers.ts": ["handleQueuedTurnCallback", "handleSharedQueuedTurnCallback", "retireApprovalCallbackIfBackendIdle"],
    "messaging-inbound-turns.ts": ["handleAdmittedTurnBundle", "startPreparedInput", "queuePreparedInput"],
    "messaging-backend-event-router.ts": ["handleBackendEventNow"],
    "messaging-turn-admission.ts": ["constructor", "queuedByThreadKey", "enqueue", "updateQueuedEntry", "findQueuedEntry", "hasDispatchingEntry", "peekNextQueued", "removeQueuedEntry", "shiftNextQueued"],
  };
  const tokens = value => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, value), result = [];
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) result.push(scanner.getTokenText());
    return JSON.stringify(result);
  };
  for (const [name, exceptions] of Object.entries(allowed)) {
    const path = root + name;
    const old = ts.createSourceFile(path, execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" }), ts.ScriptTarget.Latest, true);
    const current = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const before of old.statements.filter(ts.isClassDeclaration)) {
      const after = current.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === before.name?.text);
      for (const member of before.members) {
        const key = member.name?.getText() ?? "constructor";
        if (exceptions.includes(key)) continue;
        const actual = after?.members.find(node => (node.name?.getText() ?? "constructor") === key);
        if (!actual || tokens(member.getText()) !== tokens(actual.getText())) throw new Error(`Unreviewed owner effect change: ${name}:${key}`);
      }
    }
  }
  const recoveries = readFileSync(`${root}messaging-queue-recoveries.ts`, "utf8");
  if (/from .*messaging-controller/.test(recoveries)) throw new Error("Recovery owner imports facade");
  if (!recoveries.includes("transitionQueueRecovery")) throw new Error("Missing recovery transition owner");
}
const syntaxFailures = program.getSyntacticDiagnostics().length;
if (syntaxFailures) throw new Error(`Inventory syntax failures: ${syntaxFailures}`);
console.log(JSON.stringify({ baseline, syntaxFailures, effects: effects.length, references: references.length, seams: seams.length, ports: ports.length, directory }));
