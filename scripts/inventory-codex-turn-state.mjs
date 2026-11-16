import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// Reproducible phase 4 inventory. Full results go to an ignored log, never
// stdout. Use --output <directory> to retain separate before/after inventories.
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0 ? ".local/pwr-147/inventory" : process.argv[outputIndex + 1];
mkdirSync(output, { recursive: true });
const collections = new Set([
  "reservedCodexStartThreadIds", "activeTurnKeys", "activeCodexTurnModes",
  "activeCodexTurnCollaborationModes", "codexRetryableOperations",
  "backendActiveCodexThreadIds", "observedCodexThreadStatuses",
  "latestCodexThreadStatusObservationSequences", "codexThreadStatusObservationSequence",
  "activeCodexReviewTurnKeys", "activeCodexReviewInterruptTurnIds", "startingTurnOrigins",
  "pendingReviewStarts", "pendingReviewTerminals", "activeReviewSubAgents",
  "reviewSubAgentsByReviewTurn", "managedReviewParentsByChildThread",
]);
const operations = new Set([
  "threadHasActiveTurn", "getActiveTurnForThread", "getPendingTurnForThread",
  "reconcileBackendCodexThreadStatus", "seedBackendCodexThreadStatus",
  "reconcileCodexThreadListStatus", "findActiveCodexReviewTurnKey",
  "clearCodexReviewInterruptMappingForTurn", "emitAfterLiveThreadUsageRegistration",
  "resolveCodexThreadExecutionModeForActiveTurn", "turnState",
]);
const stateFields = new Set([
  "activities", "otherProviderReviewActivities", "otherProviderRegistrations", "otherProviderOrigins", "deletionListeners", "order", "statusSequence",
  "turns", "operations", "deliveries", "reservation", "providerStatus", "providerOrder", "observation", "statusWatermark", "origins",
  "admissions", "reviewStarts", "liveReviews", "reviewChildren", "transition",
  "cachedReviewProjection", "reviewProjection",
  "emptyActivity",
]);
const files = execFileSync("rg", ["--files", "apps/desktop", "packages/owner-core", "-g", "*.ts", "-g", "*.tsx"], { encoding: "utf8" }).trim().split("\n");
const configPath = "apps/desktop/tsconfig.json";
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();
const references = [], standIns = [], storeOptionality = [], owners = [], aliasedWrites = [];
const sourceFiles = new Map(files.map(file => [file, program.getSourceFile(file)]));
const mutationMethods = new Set(["add", "set", "delete", "clear"]);
function location(source, node) {
  const at = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file: source.fileName, line: at.line + 1, column: at.character + 1 };
}
function enclosing(node) {
  const names = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionLike(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) && parent.name) names.unshift(parent.name.getText());
    if (ts.isConstructorDeclaration(parent)) names.unshift("constructor");
  }
  return names.join(".");
}
function statement(node) {
  let parent = node;
  while (parent.parent && !ts.isStatement(parent) && !ts.isTypeElement(parent) && !ts.isClassElement(parent)) parent = parent.parent;
  return parent.getText().replace(/\s+/g, " ");
}
function symbolDeclarations(node) {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol?.declarations?.map(declaration => ({
    ...location(declaration.getSourceFile(), declaration), owner: enclosing(declaration),
  })) ?? [];
}
for (const file of files) {
  const source = sourceFiles.get(file);
  if (!source) throw new Error(`Missing AST: ${file}`);
  if (source.parseDiagnostics.length) throw new Error(`Invalid syntax: ${file}`);
  function visit(node) {
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    const ownsState = /\/(codex-thread-activity|registry-turn-state)\.ts$/.test(source.fileName);
    if (name && (collections.has(name) || operations.has(name) || (ownsState && stateFields.has(name)))) {
      let access = node;
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) access = node.parent;
      if (ts.isElementAccessExpression(node.parent)) access = node.parent;
      const method = ts.isPropertyAccessExpression(access.parent) ? access.parent.name.text : undefined;
      const declaration = node.parent.name === node && (ts.isPropertyDeclaration(node.parent) || ts.isPropertySignature(node.parent));
      const getter = ts.isGetAccessorDeclaration(node.parent) && node.parent.name === node;
      const assignment = ts.isBinaryExpression(access.parent) && access.parent.left === access && access.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && access.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const increment = (ts.isPrefixUnaryExpression(access.parent) || ts.isPostfixUnaryExpression(access.parent))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(access.parent.operator);
      const stateResult = ownsState && ts.isPropertyAssignment(node.parent) && node.parent.name === node;
      const kind = declaration ? "declaration" : getter ? "port-getter" : assignment || increment || mutationMethods.has(method) ? "mutation" : stateResult ? "state-result" : ts.isStringLiteralLike(node) ? "string-reference" : "read-or-call";
      const entry = { ...location(source, node), name, owner: enclosing(node), kind, method,
        expression: access.getText(), statement: statement(node), declarations: symbolDeclarations(node),
        insideTry: Boolean((function () { for (let parent = node.parent; parent; parent = parent.parent) if (ts.isTryStatement(parent)) return true; return false; })()),
      };
      references.push(entry);
      if (declaration && ts.isPropertyDeclaration(node.parent)) owners.push(entry);
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const type = checker.getTypeAtLocation(node);
      const properties = checker.getPropertiesOfType(type).map(property => property.name);
      const relevant = properties.filter(property => collections.has(property) || operations.has(property));
      if (relevant.length || /DesktopBackendRegistry|RegistryState|RegistryContext|RegistryTurnState|Host$/.test(node.type.getText())) {
        standIns.push({ ...location(source, node), kind: "cast", owner: enclosing(node),
          type: node.type.getText(), expression: node.expression.getText(), properties: relevant,
          declarations: type.aliasSymbol?.declarations?.map(declaration => location(declaration.getSourceFile(), declaration)) ?? symbolDeclarations(node.type) });
      }
    }
    if (ts.isNewExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      const parameter = signature?.parameters[0];
      if (parameter && checker.typeToString(checker.getTypeOfSymbolAtLocation(parameter, node)).includes("RegistryContext")) {
        standIns.push({ ...location(source, node), kind: "module-context", owner: enclosing(node),
          constructor: node.expression.getText(), argument: node.arguments?.[0]?.getText(), declarations: symbolDeclarations(node.expression) });
      }
    }
    if (ts.isCallExpression(node) && /(?:spyOn|Object\.assign|Object\.create|Object\.setPrototypeOf)$/.test(node.expression.getText())) {
      standIns.push({ ...location(source, node), kind: "override-or-prototype", owner: enclosing(node), statement: statement(node) });
    }
    if (ts.isObjectLiteralExpression(node)) {
      const relevant = node.properties.map(property => property.name?.getText().replaceAll('"', "")).filter(name => collections.has(name) || operations.has(name));
      if (relevant.length) standIns.push({ ...location(source, node), kind: "object", owner: enclosing(node), properties: relevant });
    }
    if (ts.isTypeAliasDeclaration(node) && /^(Registry.*Store|BackendRegistryOverlayStoreLike)$/.test(node.name.text)) {
      const type = checker.getTypeAtLocation(node);
      storeOptionality.push({ ...location(source, node), name: node.name.text,
        properties: checker.getPropertiesOfType(type).map(property => ({ name: property.name,
          optional: Boolean(property.flags & ts.SymbolFlags.Optional),
          type: checker.typeToString(checker.getTypeOfSymbolAtLocation(property, node)),
        })) });
    }
    if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const declarations = symbolDeclarations(node.left.name);
      if (declarations.some(declaration => /CodexRetryable|StartingTurnOrigin|PendingReviewStartRecord|ReviewSubAgentRecord/.test(declaration.owner))) {
        aliasedWrites.push({ ...location(source, node), owner: enclosing(node),
          receiverType: checker.typeToString(checker.getTypeAtLocation(node.left.expression)),
          statement: statement(node), declarations });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
// Follow callers of every method that reads/mutates activity, not just the
// hand-picked entry points. Include identifiers, string spies and named alias
// members; the checker declarations distinguish unrelated same-named methods.
const affectedMethods = new Set(references.filter(reference => reference.owner.includes(".")
  && !["declaration", "port-getter"].includes(reference.kind))
  .map(reference => reference.owner.split(".").at(-1)));
affectedMethods.add("transition");
const callers = [];
for (const [file, source] of sourceFiles) {
  function visit(node) {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && affectedMethods.has(node.text)) {
      callers.push({ ...location(source, node), name: node.text, owner: enclosing(node),
        statement: statement(node), declarations: symbolDeclarations(node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const summary = {
  base: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  command: "node scripts/inventory-codex-turn-state.mjs", files: files.length,
  matchingFiles: new Set(references.map(reference => reference.file)).size,
  references: references.length, standIns: standIns.length, aliasedWrites: aliasedWrites.length,
  affectedMethods: affectedMethods.size, callerReferences: callers.length, parseFailures: 0,
  collections: [...collections].map(name => ({ name,
    references: references.filter(reference => reference.name === name).length,
    owners: owners.filter(reference => reference.name === name).map(({ file, line, owner }) => ({ file, line, owner })),
  })),
  stateFields: [...stateFields].map(name => ({ name, references: references.filter(reference => reference.name === name).length })),
  optionalStorePorts: storeOptionality.reduce((total, store) => total + store.properties.filter(property => property.optional).length, 0),
};
if (process.argv.includes("--assert-retired")) {
  const remaining = references.filter(reference => collections.has(reference.name)
    && reference.name !== "reviewSubAgentsByReviewTurn" && reference.kind !== "string-reference");
  if (remaining.length) throw new Error(`Legacy activity references remain: ${JSON.stringify(remaining.map(({ file, line, name }) => ({ file, line, name })))}`);
}
writeFileSync(`${output}/inventory.json`, JSON.stringify({ summary, references, standIns, storeOptionality, aliasedWrites, callers }, null, 2) + "\n");
writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ ...summary, collections: summary.collections.map(({ name, references }) => ({ name, references })), output }));
