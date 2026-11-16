import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// Regenerate the move after rebasing with:
// node scripts/extract-codex-runtime-supervisor.mjs generate origin/main
const command = process.argv[2] ?? "map";
const base = process.argv[3] ?? "origin/main";
const directory = "apps/desktop/src/main/app-server";
const registryPath = `${directory}/backend-registry.ts`;
const modulePath = `${directory}/codex-runtime-supervisor.ts`;
const output = ".local/runtime-supervisor";
mkdirSync(output, { recursive: true });
const original = execFileSync("git", ["show", `${base}:${registryPath}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const tree = ts.createSourceFile(registryPath, original, ts.ScriptTarget.Latest, true);
const registry = tree.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "DesktopBackendRegistry");
assert.ok(registry);
const members = new Map(registry.members.map((node) => [node.name?.getText(tree) ?? "constructor", node]));
const seeds = [
  "restartCodexAppServer", "getCodexAppServerRestartStatus", "onCodexAppServerRestartStatusChanged",
  "maybeRestartCodexForManagedRuntimeChange", "hasActiveCodexRuntimeWork",
  "codexRuntimeRestartPending", "managedCodexRuntimeSwitchPending", "codexRuntimeRestartPromise",
  "handleCodexTurnTerminalForInvalidIdRecovery", "queueCodexInvalidIdRecovery",
  "emitCodexInvalidIdRecoveryUpdate", "maybeDrainCodexInvalidIdRecoveries", "drainCodexInvalidIdRecoveries",
  "resolveCodexInvalidIdRecoveryForkLineage", "pendingCodexInvalidIdRecoveries",
  "codexInvalidIdRecoveryAttemptedAt", "codexInvalidIdRecoveryDrain", "codexInvalidIdRecoveryAbort",
  "codexInvalidIdRecoveryBarrier", "resolveCodexInvalidIdRecoveryBarrier",
  "listBackgroundTerminals", "readCodexBackgroundTerminals", "pruneUnlistedCodexCommands",
  "refreshCodexBackgroundTerminalsAfterTurn", "publishCodexBackgroundTerminals", "terminateBackgroundTerminal",
  "codexBackgroundTerminals", "backgroundTerminalReadRevisions", "backgroundTerminalReadCounter",
  "backgroundTerminalGeneration", "liveCodexToolItemsByThread", "settleCodexToolItems",
  "trackLiveCodexToolItem", "handleCodexAppServerUnexpectedExit",
  "startCodexAppServerRecycler", "scheduleCodexAppServerRecycleCheck", "checkCodexAppServerRecycle",
  "hasCodexWorkBlockingRecycle", "readCodexAppServerDiagnostics", "startCodexIdleThreadUnsubscriber",
  "unsubscribeIdleCodexThreads", "codexThreadNeedsLiveEvents",
  "codexAppServerRecycleTimer", "codexIdleThreadTimer",
];
const moved = new Set(seeds);
const refs = new Map();
function visit(node, callback) { callback(node); ts.forEachChild(node, (child) => visit(child, callback)); }
for (const [owner, member] of members) {
  visit(member, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    const direct = node.expression.kind === ts.SyntaxKind.ThisKeyword;
    const current = ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === "current";
    if (!direct && !current) return;
    const name = node.name.text;
    if (!refs.has(name)) refs.set(name, []);
    refs.get(name).push({ owner, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, current, text: node.parent.getText(tree).slice(0, 260) });
  });
}
// Only propose helpers that are exclusively reached by the domain. Review the
// proposals: constructor/port-only fields are composition, not domain state.
let changed = true;
const proposals = [];
while (changed) {
  changed = false;
  for (const [name, node] of members) {
    if (moved.has(name) || ["constructor", "constructionPorts", "listActiveCodexWorkThreadIds", "hasActiveCodexWork"].includes(name)) continue;
    if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)) continue;
    const uses = (refs.get(name) ?? []).filter((ref) => ref.owner !== name && ref.owner !== "constructor" && ref.owner !== "constructionPorts");
    if (!uses.length || !uses.every((ref) => moved.has(ref.owner))) continue;
    moved.add(name);
    proposals.push(name);
    changed = true;
  }
}
const report = [...moved].map((name) => {
  const node = members.get(name);
  assert.ok(node, name);
  return { name, kind: ts.SyntaxKind[node.kind], start: tree.getLineAndCharacterOfPosition(node.getFullStart()).line + 1,
    end: tree.getLineAndCharacterOfPosition(node.end).line + 1, callers: refs.get(name) ?? [] };
});
const dependencies = [...new Set(report.flatMap(({name}) => {
  const names = [];
  visit(members.get(name), (node) => {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && !moved.has(node.name.text)) names.push(node.name.text);
  });
  return names;
}))].sort();
writeFileSync(`${output}/map.json`, JSON.stringify({ base, proposals, members: report, dependencies }, null, 2) + "\n");
if (command === "map") {
  const callers = [];
  const root = "apps/desktop/src";
  for (const relative of readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => /\.tsx?$/.test(file))) {
    const file = path.join(root, relative);
    if (file === registryPath) continue;
    const text = readFileSync(file, "utf8");
    if (![...moved].some((name) => text.includes(name))) continue;
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    visit(ast, (node) => {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && moved.has(node.text)) {
        callers.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, name: node.text, kind: ts.SyntaxKind[node.parent.kind], text: node.parent.getText(ast).slice(0, 260) });
      }
    });
  }
  writeFileSync(`${output}/callers.json`, JSON.stringify(callers, null, 2) + "\n");
  console.log(JSON.stringify({ base, seeds: seeds.length, proposals, lines: report.reduce((n, row) => n + row.end - row.start, 0), dependencies,
    callers: callers.length, callerFiles: new Set(callers.map((row) => row.file)).size, reports: [`${output}/map.json`, `${output}/callers.json`] }, null, 2));
  process.exit(0);
}

const configuration = ["resolveCodexAppServerRecycleSettingsFn", "codexThreadIdleUnsubscribeMs", "markManagedCodexRuntimeSwitchCompleteFn"];
const collaborators = ["threadUsageLedger", "threadArchiveCoordinator", "threadWorkspaceService"];
const contextRewrites = {
  codexClient: "context.providers.codex", claudeBackend: "context.providers.claude", closed: "context.lifecycle.closed", emit: "context.emit",
};
const storeGroups = { getThreadOverlayState: "threads", setTurnFailureCodexInvalidIdRecovery: "threads" };
const hostNames = dependencies.filter((name) => !collaborators.includes(name) && !(name in contextRewrites) && name !== "overlayStore");
const shared = ["liveSubAgentMonitorIds", "prepareTokenMiserRuntime", "threadHasActiveTurn", "withCodexThreadClient"];
const publicMethods = new Set([...moved].filter((name) => ts.isMethodDeclaration(members.get(name))
  && (refs.get(name) ?? []).some((ref) => !moved.has(ref.owner))));
// Filled from the production compiler's missing-member errors with no facades.
const facades = command === "without-facades" ? [] : [
  "terminateBackgroundTerminal", "listBackgroundTerminals", "startCodexIdleThreadUnsubscriber",
  "startCodexAppServerRecycler", "readCodexAppServerDiagnostics", "onCodexAppServerRestartStatusChanged",
  "getCodexAppServerRestartStatus", "restartCodexAppServer",
];

function edits(text, replacements) {
  for (const { start, end, text: replacement } of replacements.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  return text;
}
function signature(node) {
  let result = original.slice(node.getStart(tree), node.body.getStart(tree)).replace(/^(?:private |async )+/, "").trimEnd();
  const ast = ts.createSourceFile("signature.ts", `class Signature { ${result} {} }`, ts.ScriptTarget.Latest, true);
  const method = ast.statements[0].members[0];
  const changes = [];
  for (const parameter of method.parameters) {
    if (!parameter.initializer) continue;
    const initStart = parameter.type?.end ?? parameter.name.end;
    changes.push({ start: initStart - 18, end: parameter.end - 18, text: "" });
    if (!parameter.questionToken) changes.push({ start: parameter.name.end - 18, end: parameter.name.end - 18, text: "?" });
  }
  return edits(result, changes);
}
function rewriteBody(text) {
  const ast = ts.createSourceFile("member.ts", `class M {${text}\n}`, ts.ScriptTarget.Latest, true);
  const replacements = [];
  visit(ast, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const name = node.name.text;
      if (name === "overlayStore") return;
      const replacement = contextRewrites[name] ?? (hostNames.includes(name) ? `host().${name}` : undefined);
      if (replacement) replacements.push({ start: node.getStart(ast) - 9, end: node.end - 9, text: `this.${replacement}` });
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === "overlayStore") {
      assert.ok(storeGroups[node.name.text], node.name.text);
      replacements.push({ start: node.expression.getStart(ast) - 9, end: node.expression.end - 9, text: `this.context.stores.${storeGroups[node.name.text]}` });
    }
    if (ts.isIdentifier(node) && node.text === "DesktopBackendRegistry") replacements.push({ start: node.getStart(ast) - 9, end: node.end - 9, text: "CodexRuntimeSupervisor" });
  });
  return edits(text, replacements);
}
const imports = tree.statements.filter(ts.isImportDeclaration).map((node) => node.getText(tree)).join("\n");
const hostFields = {
  activeCodexTurnModes: "readonly activeCodexTurnModes: ReadonlyMap<string, ThreadExecutionMode>;",
  activeTurnKeys: "readonly activeTurnKeys: ReadonlySet<string>;",
  backendActiveCodexThreadIds: "readonly backendActiveCodexThreadIds: ReadonlySet<string>;",
  reservedCodexStartThreadIds: "readonly reservedCodexStartThreadIds: ReadonlySet<string>;",
  nativeVoiceLeases: "readonly nativeVoiceLeases: number;",
  tokenMiserServerCapabilities: "readonly tokenMiserServerCapabilities: WeakMap<BackendClient, Promise<CodexServerCapabilities | undefined>>;",
  shutdownRequested: "readonly shutdownRequested: boolean;",
  codexRetryableOperations: "readonly codexRetryableOperations: Map<string, CodexRetryableOperation>;",
  threadStarts: "readonly threadStarts: ThreadTurnStartLifecycle;",
  threadTurnQueue: "readonly threadTurnQueue: ThreadTurnQueue;",
};
const hostDeclarations = hostNames.filter((name) => !shared.includes(name)).map((name) => {
  const node = members.get(name);
  if (ts.isMethodDeclaration(node)) return `  ${signature(node)};`;
  if (hostFields[name]) return `  ${hostFields[name]}`;
  assert.ok(node.type, `hand-fix host property ${name}`);
  const writes = ["tokenMiserReducerCapabilityState", "tokenMiserCodeModeGroupingVersion", "tokenMiserPostToolUseExactOutputVersion", "tokenMiserRuntimePreparationFailure"];
  return `  ${writes.includes(name) ? "" : "readonly "}${name}${node.questionToken ? "?" : ""}: ${node.type.getText(tree)};`;
});
const extraImports = `import type { RegistryHost } from "./registry-context";
import type { RegistryHostPorts } from "./registry-host-ports";`;
const header = `${imports}\n${extraImports}\n
const backendRegistryLog = getMainLogger("pwragent:backend-registry");

export interface CodexRuntimeSupervisorDependencies {
  readonly threadUsageLedger: ThreadUsageLedger;
  readonly threadArchiveCoordinator: ThreadArchiveCoordinator;
  readonly threadWorkspaceService: ThreadWorkspaceService;
${configuration.map((name) => `  readonly ${name}: ${members.get(name).type.getText(tree)};`).join("\n")}
}

/** Turn activity remains registry-owned until phase 4 of the split. */
export interface CodexRuntimeSupervisorHost extends Pick<RegistryHostPorts,
${shared.map((name, index) => `  ${index ? "| " : ""}"${name}"`).join("\n")}
> {
${hostDeclarations.join("\n")}
}

/** Codex process restarts, invalid-ID recovery and background process lifecycle. */
export class CodexRuntimeSupervisor {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<CodexRuntimeSupervisorHost>;
${collaborators.map((name) => `  private readonly ${name}: ${name[0].toUpperCase() + name.slice(1)};`).join("\n")}

  constructor(
    context: RegistryContext,
    dependencies: CodexRuntimeSupervisorDependencies,
    host: RegistryHost<CodexRuntimeSupervisorHost>,
  ) {
    this.context = context;
    this.host = host;
${[...collaborators, ...configuration].map((name) => `    this.${name} = dependencies.${name};`).join("\n")}
  }
`;
// These small adapters preserve registry reads and shutdown ordering without
// giving the registry mutable access to the module's state.
const adapters = `
  get runtimeRestartPending(): boolean { return this.codexRuntimeRestartPending; }
  setRuntimeRestartPending(value: boolean): void { this.codexRuntimeRestartPending = value; }
  get managedRuntimeSwitchPending(): boolean { return this.managedCodexRuntimeSwitchPending; }
  setManagedRuntimeSwitchPending(value: boolean): void { this.managedCodexRuntimeSwitchPending = value; }
  get runtimeRestartPromise(): Promise<boolean> | undefined { return this.codexRuntimeRestartPromise; }
  get backgroundTerminalRecords(): ReadonlyMap<string, CodexBackgroundTerminal[]> { return this.codexBackgroundTerminals; }
  get liveToolItemRecords(): ReadonlyMap<string, ReadonlyMap<string, LiveCodexToolItem>> { return this.liveCodexToolItemsByThread; }
  get pendingInvalidIdRecoveryRecords(): readonly PendingCodexInvalidIdRecovery[] { return this.pendingCodexInvalidIdRecoveries; }
  get invalidIdRecoveryBarrier(): Promise<void> | undefined { return this.codexInvalidIdRecoveryBarrier; }
  get invalidIdRecoveryDrain(): Promise<void> | undefined { return this.codexInvalidIdRecoveryDrain; }

  clearBackgroundTerminalsForShutdown(): void {
    this.backgroundTerminalGeneration += 1;
    this.codexBackgroundTerminals.clear();
    this.backgroundTerminalReadRevisions.clear();
  }

  abortInvalidIdRecoveriesForShutdown(): void {
    this.codexInvalidIdRecoveryAbort.abort();
  }

  stopAppServerRecycler(): void {
    if (this.codexAppServerRecycleTimer) {
      clearTimeout(this.codexAppServerRecycleTimer);
      this.codexAppServerRecycleTimer = undefined;
    }
  }

  stopIdleThreadUnsubscriber(): void {
    if (this.codexIdleThreadTimer) {
      clearInterval(this.codexIdleThreadTimer);
      this.codexIdleThreadTimer = undefined;
    }
  }

  rejectPendingInvalidIdRecoveriesForShutdown(): void {
    const recoveryCloseError = new Error(
      "Desktop backend registry closed before Codex history recovery completed",
    );
    for (const recovery of this.pendingCodexInvalidIdRecoveries.splice(0)) {
      recovery.reject(recoveryCloseError);
    }
    if (!this.codexInvalidIdRecoveryDrain) {
      this.resolveCodexInvalidIdRecoveryBarrier?.();
      this.resolveCodexInvalidIdRecoveryBarrier = undefined;
      this.codexInvalidIdRecoveryBarrier = undefined;
    }
  }
`;
const movedBody = registry.members.filter((node) => moved.has(node.name?.getText(tree))).map((node) => {
  let text = original.slice(node.getFullStart(), node.end);
  if (publicMethods.has(node.name.getText(tree))) text = text.replace(/\bprivate /, "");
  return rewriteBody(text);
}).join("");
let moduleText = header + adapters + movedBody + "\n}\n";

const stateReads = {
  codexRuntimeRestartPending: "runtimeRestartPending", managedCodexRuntimeSwitchPending: "managedRuntimeSwitchPending",
  codexRuntimeRestartPromise: "runtimeRestartPromise", codexBackgroundTerminals: "backgroundTerminalRecords",
  liveCodexToolItemsByThread: "liveToolItemRecords", pendingCodexInvalidIdRecoveries: "pendingInvalidIdRecoveryRecords",
  codexInvalidIdRecoveryBarrier: "invalidIdRecoveryBarrier", codexInvalidIdRecoveryDrain: "invalidIdRecoveryDrain",
};
let registryText = original;
const replacements = [];
for (const [name, node] of members) {
  if (!moved.has(name)) continue;
  const facade = facades.includes(name) ? `\n\n  ${original.slice(node.getStart(tree), node.body.getStart(tree)).replace(/^async /, "")}{\n    return this.codexRuntimeSupervisor.${name}(${node.parameters.map((parameter) => parameter.name.getText(tree)).join(", ")});\n  }` : "";
  replacements.push({ start: node.getFullStart(), end: node.end, text: facade });
}
// Move configuration assignments out of the registry constructor.
for (const statement of members.get("constructor").body.statements) {
  if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
    && configuration.includes(statement.expression.left.name?.text)) replacements.push({ start: statement.getFullStart(), end: statement.end, text: "" });
}
registryText = edits(registryText, replacements);
const blocks = [
  ["    this.backgroundTerminalGeneration += 1;\n    this.codexBackgroundTerminals.clear();\n    this.backgroundTerminalReadRevisions.clear();", "    this.codexRuntimeSupervisor.clearBackgroundTerminalsForShutdown();"],
  ["    this.codexInvalidIdRecoveryAbort.abort();", "    this.codexRuntimeSupervisor.abortInvalidIdRecoveriesForShutdown();"],
  [adapters.match(/  stopAppServerRecycler\(\): void \{\n([\s\S]*?)\n  \}/)[1], "    this.codexRuntimeSupervisor.stopAppServerRecycler();"],
  [adapters.match(/  stopIdleThreadUnsubscriber\(\): void \{\n([\s\S]*?)\n  \}/)[1], "    this.codexRuntimeSupervisor.stopIdleThreadUnsubscriber();"],
  [adapters.match(/  rejectPendingInvalidIdRecoveriesForShutdown\(\): void \{\n([\s\S]*?)\n  \}/)[1], "    this.codexRuntimeSupervisor.rejectPendingInvalidIdRecoveriesForShutdown();"],
];
writeFileSync(`${output}/proof-manifest.json`, JSON.stringify({ base, moved: [...moved], publicMethods: [...publicMethods], configuration, facades, contextRewrites, storeGroups, hostNames, stateReads, blocks }, null, 2) + "\n");
for (const [before, after] of blocks) {
  assert.ok(registryText.includes(before), before);
  registryText = registryText.replace(before, after);
}
registryText = registryText.replace("this.codexRuntimeRestartPending = true;", "this.codexRuntimeSupervisor.setRuntimeRestartPending(true);")
  .replace("current().codexRuntimeRestartPending = value;", "current().codexRuntimeSupervisor.setRuntimeRestartPending(value);")
  .replace("current().managedCodexRuntimeSwitchPending = value;", "current().codexRuntimeSupervisor.setManagedRuntimeSwitchPending(value);");
for (const name of moved) {
  if (configuration.includes(name)) continue;
  const replacement = stateReads[name] ?? name;
  registryText = registryText.replaceAll(`this.${name}`, `this.codexRuntimeSupervisor.${replacement}`)
    .replaceAll(`current().${name}`, `current().codexRuntimeSupervisor.${replacement}`);
}
registryText = `import type { CodexRuntimeSupervisor } from "./codex-runtime-supervisor";\n` + registryText;
registryText = registryText.replace("  private readonly threadDirectoryService: ThreadDirectoryService;", "  private readonly threadDirectoryService: ThreadDirectoryService;\n  private readonly codexRuntimeSupervisor: CodexRuntimeSupervisor;")
  .replace("    this.threadDirectoryService = dependencies.threadDirectoryService;", "    this.threadDirectoryService = dependencies.threadDirectoryService;\n    this.codexRuntimeSupervisor = dependencies.codexRuntimeSupervisor;");
// Add missing host members in constructionPorts' sorted portion. Existing
// out-of-order entries are deliberately left at their original locations.
const mutable = ["tokenMiserReducerCapabilityState", "tokenMiserCodeModeGroupingVersion", "tokenMiserPostToolUseExactOutputVersion", "tokenMiserRuntimePreparationFailure"];
for (const name of hostNames) {
  const portTree = ts.createSourceFile(registryPath, registryText, ts.ScriptTarget.Latest, true);
  const portClass = portTree.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "DesktopBackendRegistry");
  const portMethod = portClass.members.find((node) => node.name?.getText(portTree) === "constructionPorts");
  const portObject = portMethod.body.statements.find(ts.isReturnStatement).expression;
  const portNames = new Set(portObject.properties.map((node) => node.name?.getText(portTree)));
  const node = members.get(name);
  if (portNames.has(name)) {
    if (mutable.includes(name) && !portObject.properties.some((property) => ts.isSetAccessorDeclaration(property) && property.name.getText(portTree) === name)) {
      const getter = portObject.properties.find((property) => property.name?.getText(portTree) === name);
      registryText = edits(registryText, [{ start: getter.end + 1, end: getter.end + 1, text: `\n      set ${name}(value) { current().${name} = value; },` }]);
    }
    continue;
  }
  const member = ts.isMethodDeclaration(node)
    ? `      ${name}: (...args: Parameters<typeof this.${name}>) => this.${name}(...args),`
    : `      get ${name}() { return current().${name}; },${mutable.includes(name) ? `\n      set ${name}(value) { current().${name} = value; },` : ""}`;
  const next = portObject.properties.find((property) => property.name?.getText(portTree) > name);
  const point = next ? next.getFullStart() : portObject.end - 1;
  registryText = edits(registryText, [{ start: point, end: point, text: `\n${member}` }]);
}
assert.equal(ts.createSourceFile(modulePath, moduleText, ts.ScriptTarget.Latest, true).parseDiagnostics.length, 0, "generated module must parse");
assert.equal(ts.createSourceFile(registryPath, registryText, ts.ScriptTarget.Latest, true).parseDiagnostics.length, 0, "generated registry must parse");
writeFileSync(modulePath, moduleText);
writeFileSync(registryPath, registryText);
function support(file, transform) {
  const before = execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(file, transform(before));
}
support(`${directory}/backend-registry-construction.ts`, (text) => {
  text = `import type { CodexRuntimeSupervisor } from "./codex-runtime-supervisor";\n` + text;
  text = text.replace("  threadDirectoryService: ThreadDirectoryService;", "  threadDirectoryService: ThreadDirectoryService;\n  codexRuntimeSupervisor: CodexRuntimeSupervisor;");
  for (const name of configuration) text = text.replace(new RegExp(`^  ${name}:.*\\n`, "m"), "");
  return text;
});
support(`${directory}/backend-registry-wiring.ts`, (text) => {
  text = `import { CodexRuntimeSupervisor } from "./codex-runtime-supervisor";\n` + text;
  text = text.replace("  readonly threadDirectoryService: ThreadDirectoryService;", "  readonly threadDirectoryService: ThreadDirectoryService;\n  readonly codexRuntimeSupervisor: CodexRuntimeSupervisor;");
  text = text.replace("        setThreadScheduledStart: (...args) => overlayStore.setThreadScheduledStart(...args),", "        setThreadScheduledStart: (...args) => overlayStore.setThreadScheduledStart(...args),\n        setTurnFailureCodexInvalidIdRecovery: (...args) => overlayStore.setTurnFailureCodexInvalidIdRecovery(...args),");
  text = text.replace("  const registry = new DesktopBackendRegistry({", `  const codexRuntimeSupervisor = new CodexRuntimeSupervisor(context, {\n${[...collaborators, ...configuration].map((name) => `    ${name},`).join("\n")}\n  }, () => ports);\n\n  const registry = new DesktopBackendRegistry({`);
  text = text.replaceAll("    threadDirectoryService,\n", "    threadDirectoryService,\n    codexRuntimeSupervisor,\n");
  // The module, above, owns these inputs. Remove them only from the registry's
  // dependency object, preserving the option defaults in the composition root.
  const start = text.indexOf("  const registry = new DesktopBackendRegistry({");
  text = text.slice(0, start) + configuration.reduce((tail, name) => tail.replace(`    ${name},\n`, ""), text.slice(start));
  return text;
});
support(`${directory}/registry-context.ts`, (text) => text.replace('  | "setThreadForkOrigin" | "setThreadHandoffOrigin" | "setThreadScheduledStart"', '  | "setThreadForkOrigin" | "setThreadHandoffOrigin" | "setThreadScheduledStart"\n  | "setTurnFailureCodexInvalidIdRecovery"'));
// Move the newly shared operations into the common host contract.
support(`${directory}/registry-host-ports.ts`, (text) => {
  for (const name of ["liveSubAgentMonitorIds", "prepareTokenMiserRuntime"]) {
    const node = members.get(name);
    const declaration = `  ${signature(node)};\n`;
    const ast = ts.createSourceFile("ports.ts", text, ts.ScriptTarget.Latest, true);
    const contract = ast.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === "RegistryHostPorts");
    const next = contract.members.find((node) => node.name.getText(ast) > name);
    const point = next?.getFullStart() ?? contract.end - 1;
    text = text.slice(0, point) + "\n" + declaration.trimEnd() + text.slice(point);
  }
  return text;
});
for (const [file, name] of [["thread-usage-ledger", "liveSubAgentMonitorIds"], ["managed-review-service", "prepareTokenMiserRuntime"]]) {
  support(`${directory}/${file}.ts`, (text) => {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const host = ast.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text.endsWith("Host"));
    const node = host.members.find((node) => node.name?.getText(ast) === name);
    assert.ok(node);
    text = edits(text, [{ start: node.getFullStart(), end: node.end, text: "" }]);
    const pickEnd = text.indexOf("> {", host.getStart(ast));
    return text.slice(0, pickEnd) + `  | "${name}"\n` + text.slice(pickEnd);
  });
}
support("apps/desktop/src/main/__tests__/registry-host-ports.property.test.ts", (text) => {
  text = 'import type { CodexRuntimeSupervisorHost } from "../app-server/codex-runtime-supervisor";\n' + text;
  text = text.replace("type Hosts = {", "type Hosts = {\n  CodexRuntimeSupervisorHost: CodexRuntimeSupervisorHost;");
  return text.replace("  const checkedHosts: Record<keyof Hosts, true> = {", "  const checkedHosts: Record<keyof Hosts, true> = {\n    CodexRuntimeSupervisorHost: true,");
});
support("apps/desktop/src/main/__tests__/backend-registry-wiring.property.test.ts", (text) => text.replace('"thread-directory-service.ts"]', '"thread-directory-service.ts", "codex-runtime-supervisor.ts"]'));
support("apps/desktop/src/main/__tests__/turn-event-stream.test.ts", (text) => {
  for (const name of ["maybeRestartCodexForManagedRuntimeChange", "refreshCodexBackgroundTerminalsAfterTurn"]) text = text.replace(`    "${name}",\n`, "");
  return text.replace("  // Moved to the forge tool bridge", `  // Moved to the Codex runtime supervisor (PWR-146).\n  ...[\n    "maybeRestartCodexForManagedRuntimeChange",\n    "refreshCodexBackgroundTerminalsAfterTurn",\n  ].map((name) => ({\n    name,\n    owner: (registry: Members) => registryModules(registry as unknown as DesktopBackendRegistry).codexRuntimeSupervisor as unknown as Members,\n  })),\n  // Moved to the forge tool bridge`);
});

// Oxlint identifies unused bindings; TypeScript AST spans restrict deletions
// to import declarations. No logic or other declarations are pruned.
let lintOutput;
try { lintOutput = execFileSync("pnpm", ["exec", "oxlint", "--format", "json", modulePath, registryPath, `${directory}/backend-registry-construction.ts`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }); }
catch (error) { lintOutput = error.stdout; }
const diagnostics = JSON.parse(lintOutput).diagnostics;
writeFileSync(`${output}/import-pruning.json`, JSON.stringify(diagnostics, null, 2) + "\n");
let pruned = 0;
for (const file of [modulePath, registryPath, `${directory}/backend-registry-construction.ts`]) {
  const text = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const unused = diagnostics.filter((diagnostic) => diagnostic.filename === file && diagnostic.code?.includes("no-unused-vars"))
    .flatMap((diagnostic) => diagnostic.labels.map((label) => label.span.offset));
  const isUnused = (node) => unused.some((offset) => node.getStart(ast) <= offset && offset < node.end);
  const changes = [];
  for (const node of ast.statements.filter(ts.isImportDeclaration)) {
    const clause = node.importClause;
    if (!clause) continue;
    const binding = clause.namedBindings;
    const defaultName = clause.name && !isUnused(clause.name) ? clause.name.getText(ast) : "";
    const named = binding && ts.isNamedImports(binding) ? binding.elements.filter((element) => !isUnused(element)) : [];
    const namespace = binding && ts.isNamespaceImport(binding) && !isUnused(binding.name) ? binding.getText(ast) : "";
    if (!(file === modulePath && binding && ts.isNamedImports(binding) && !binding.elements.length) && defaultName === (clause.name?.getText(ast) ?? "") && named.length === (binding && ts.isNamedImports(binding) ? binding.elements.length : 0)
      && namespace === (binding && ts.isNamespaceImport(binding) ? binding.getText(ast) : "")) continue;
    const multiline = binding?.getText(ast).includes("\n");
    const names = named.length ? (multiline ? `{\n${named.map((element) => `  ${element.getText(ast)},`).join("\n")}\n}` : `{ ${named.map((element) => element.getText(ast)).join(", ")} }`) : namespace;
    const bindings = [defaultName, names].filter(Boolean).join(", ");
    const replacement = bindings ? `import ${clause.isTypeOnly ? "type " : ""}${bindings} from ${node.moduleSpecifier.getText(ast)};` : "";
    changes.push({ start: node.getStart(ast), end: node.end + (replacement ? 0 : 1), text: replacement });
    pruned += 1;
  }
  writeFileSync(file, edits(text, changes));
}
console.log(`Pruned unused bindings in ${pruned} import declarations using Oxlint diagnostics and TypeScript spans.`);
console.log(`Generated ${moved.size} members (${publicMethods.size} exposed to the registry), ${facades.length} facades and ${hostNames.length} host members from ${base}.`);
