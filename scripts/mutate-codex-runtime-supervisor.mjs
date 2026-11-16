import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// A deliberately broken module/facade/host for each contract. First run the
// baseline with pnpm test, which builds the test runtime. This runner then
// invokes that same Vitest project without rebuilding it for every mutation.
// Run only when no other test/lint/regeneration command is using these files.
const modulePath = "apps/desktop/src/main/app-server/codex-runtime-supervisor.ts";
const registryPath = "apps/desktop/src/main/app-server/backend-registry.ts";
const testPath = "apps/desktop/src/main/__tests__/codex-runtime-supervisor.test.ts";
const directory = ".local/runtime-supervisor/mutations";
mkdirSync(directory, { recursive: true });
const mutations = [];
function member(name, method, before, after, test, file = modulePath) {
  mutations.push({ name, file, test, transform(text) {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const owner = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === (file === modulePath ? "CodexRuntimeSupervisor" : "DesktopBackendRegistry"));
    const node = owner.members.find((node) => (ts.isConstructorDeclaration(node) ? "constructor" : node.name?.getText(ast)) === method);
    assert.ok(node, method);
    const source = node.getText(ast);
    assert.ok(source.includes(before), `${name}: mutation target not found`);
    return text.slice(0, node.getStart(ast)) + source.replace(before, after) + text.slice(node.end);
  } });
}
const admission = "restarts exactly at an open";
for (const [signal, expression] of [
  ["voice", "this.host().nativeVoiceLeases > 0"],
  ["reserved", "this.host().reservedCodexStartThreadIds.size > 0"],
  ["backend", "this.host().backendActiveCodexThreadIds.size > 0"],
  ["terminal", "this.codexBackgroundTerminals.size > 0"],
  ["tool", "this.liveCodexToolItemsByThread.size > 0"],
  ["mode", "this.host().activeCodexTurnModes.size > 0"],
  ["turn", 'key.startsWith("codex:")'],
]) member(`restart-ignores-${signal}`, "hasActiveCodexRuntimeWork", expression, "false", admission);
member("restart-while-closed", "maybeRestartCodexForManagedRuntimeChange", "this.context.lifecycle.closed", "false", admission);
member("restart-without-request", "maybeRestartCodexForManagedRuntimeChange", "!this.codexRuntimeRestartPending", "false", admission);
for (const [name, expression] of [
  ["clear-request", "this.codexRuntimeRestartPending = false;"],
  ["clear-managed-switch", "this.managedCodexRuntimeSwitchPending = false;"],
  ["reset-client-breaker", 'this.context.providers.codex.resetAppServerRestarts?.("Codex runtime changed");'],
  ["clear-capabilities", "this.host().tokenMiserServerCapabilities.delete(this.context.providers.codex);"],
  ["clear-reducer", "this.host().tokenMiserReducerCapabilityState = undefined;"],
  ["clear-grouping", "this.host().tokenMiserCodeModeGroupingVersion = undefined;"],
  ["clear-output-version", "this.host().tokenMiserPostToolUseExactOutputVersion = undefined;"],
  ["clear-runtime-failure", "this.host().tokenMiserRuntimePreparationFailure = undefined;"],
  ["initialize-ledger", "await this.threadUsageLedger.initializeTokenMiserLedger();"],
  ["prepare-runtime", "await this.host().prepareTokenMiserRuntime();"],
  ["complete-managed-switch", "this.markManagedCodexRuntimeSwitchCompleteFn();"],
]) member(`restart-skips-${name}`, "maybeRestartCodexForManagedRuntimeChange", expression, "void 0;", admission);
member("restart-failure-forgets-request", "maybeRestartCodexForManagedRuntimeChange", "this.codexRuntimeRestartPending = true;", "void 0;", "keeps the switch requested");
for (const [name, expression] of [
  ["tool-kind", 'itemType === "commandexecution"'], ["membership", "!listed.has(itemId)"], ["turn-end", "turnEnded\n"],
]) member(`prune-ignores-${name}`, "pruneUnlistedCodexCommands", expression, name === "turn-end" ? "true\n" : "true", "prunes only ended");
member("prune-keeps-empty-thread", "pruneUnlistedCodexCommands", "this.liveCodexToolItemsByThread.delete(threadId);", "void 0;", "prunes only ended");
member("prune-does-not-release-restart", "pruneUnlistedCodexCommands", "void this.maybeRestartCodexForManagedRuntimeChange();", "void 0;", "prunes only ended");
member("publish-repeats-same-membership", "publishCodexBackgroundTerminals", "backgroundTerminalMembership(previous) === backgroundTerminalMembership(terminals)", "false", "publishes membership changes");
member("publish-while-closed", "publishCodexBackgroundTerminals", "|| this.context.lifecycle.closed", "|| false", "publishes membership changes");
member("publish-keeps-deleted-list", "publishCodexBackgroundTerminals", "this.codexBackgroundTerminals.delete(threadId);", "void 0;", "publishes membership changes");
for (const [name, expression] of [
  ["generation", "generation === this.backgroundTerminalGeneration"],
  ["revision", "revision === this.backgroundTerminalReadRevisions.get(threadId)"],
  ["closed", "!this.context.lifecycle.closed"],
]) member(`read-ignores-${name}`, "readCodexBackgroundTerminals", expression, "true", "ignores reads made stale");
member("read-leaks-revision", "readCodexBackgroundTerminals", "this.backgroundTerminalReadRevisions.delete(threadId);", "void 0;", "ignores reads made stale");
const queue = "drains one persisted FIFO";
member("queue-duplicates-recovery", "queueCodexInvalidIdRecovery", "if (queued)", "if (false)", queue);
member("queue-does-not-persist-before-repair", "queueCodexInvalidIdRecovery", "await this.context.stores.threads.setTurnFailureCodexInvalidIdRecovery({\n      threadId,\n      turnId,\n      recovery: audit,\n    });", "void 0;", "fails closed when the durable");
member("queue-reverses-FIFO", "drainCodexInvalidIdRecoveries", "this.pendingCodexInvalidIdRecoveries.shift()!", "this.pendingCodexInvalidIdRecoveries.pop()!", queue);
member("queue-retries-without-loop-guard", "drainCodexInvalidIdRecoveries", "invalidIdRecoveryAttempted: true", "invalidIdRecoveryAttempted: false", queue);
member("queue-loses-origin", "drainCodexInvalidIdRecoveries", "resolveThreadMessageOrigin(recovery.params)", "undefined", queue);
member("queue-drops-resolved-completion", "drainCodexInvalidIdRecoveries", "recovery.resolve({", "void ({", queue);
for (const [name, expression] of [
  ["closed", "this.context.lifecycle.closed"], ["identity", "!turnId"], ["failed-log", "!failedTurn"],
  ["memory-cooldown", "reservedAt !== undefined"], ["persisted-cooldown", "lastPersistedAttemptAt !== undefined"], ["log-cooldown", "if (recentAttempt)"],
]) member(`queue-ignores-${name}`, "queueCodexInvalidIdRecovery", expression, name === "log-cooldown" ? "if (false)" : "false", "refuses closed, unidentified");
member("fork-lineage-forgets-parent", "resolveCodexInvalidIdRecoveryForkLineage", "lineage.push(sourceThreadId);", "void 0;", "follows fork provenance");
for (const method of ["clearBackgroundTerminalsForShutdown", "abortInvalidIdRecoveriesForShutdown", "stopAppServerRecycler", "stopIdleThreadUnsubscriber", "rejectPendingInvalidIdRecoveriesForShutdown"]) {
  mutations.push({ name: `no-op-${method}`, file: modulePath, test: "clears terminal reads", transform(text) {
    const ast = ts.createSourceFile(modulePath, text, ts.ScriptTarget.Latest, true);
    const owner = ast.statements.find((node) => ts.isClassDeclaration(node));
    const node = owner.members.find((node) => node.name?.getText(ast) === method);
    return text.slice(0, node.body.getStart(ast)) + "{}" + text.slice(node.body.end);
  } });
}
member("construction-reads-host", "constructor", "this.context = context;", "host(); this.context = context;", "reads no host");
for (const method of ["listBackgroundTerminals", "terminateBackgroundTerminal", "startCodexIdleThreadUnsubscriber", "startCodexAppServerRecycler", "readCodexAppServerDiagnostics", "onCodexAppServerRestartStatusChanged", "getCodexAppServerRestartStatus", "restartCodexAppServer"]) {
  member(`facade-${method}`, method, `return this.codexRuntimeSupervisor.${method}`, `return undefined as never; void this.codexRuntimeSupervisor.${method}`, "returns the module's exact", registryPath);
}
member("port-reads-detached-terminal-map", "constructionPorts", "return current().codexRuntimeSupervisor.backgroundTerminalRecords;", "return new Map();", "routes existing host reads", registryPath);
member("port-forgets-pending-write", "constructionPorts", "current().codexRuntimeSupervisor.setRuntimeRestartPending(value);", "void value;", "routes existing host reads", registryPath);
member("port-forgets-managed-write", "constructionPorts", "current().codexRuntimeSupervisor.setManagedRuntimeSwitchPending(value);", "void value;", "routes existing host reads", registryPath);
member("registry-forgets-shutdown-rejection", "closeResources", "this.codexRuntimeSupervisor.rejectPendingInvalidIdRecoveriesForShutdown();", "void 0;", "routes existing host reads", registryPath);
member("registry-forgets-live-tools", "getInProgressThreadSnapshot", "this.codexRuntimeSupervisor.liveToolItemRecords.keys()", "new Map<string, never>().keys()", "shows module-owned background", registryPath);

if (process.argv.includes("--list")) {
  console.log(JSON.stringify(mutations.map(({ name, file, test }) => ({ name, file, test })), null, 2));
  process.exit(0);
}
const previous = existsSync(`${directory}/results.json`) ? JSON.parse(readFileSync(`${directory}/results.json`, "utf8")) : [];
const retrying = process.argv[2] === "--retry-survivors";
const selected = retrying ? mutations.filter((mutation) => previous.some((result) => result.name === mutation.name && !result.caught))
  : process.argv[2] ? mutations.filter((mutation) => mutation.name.includes(process.argv[2])) : mutations;
assert.ok(selected.length, "no matching mutations");
const baseline = new Map([modulePath, registryPath].map((file) => [file, readFileSync(file, "utf8")]));
const results = retrying ? previous.filter((result) => !selected.some((mutation) => mutation.name === result.name)) : [];
try {
  for (const [index, mutation] of selected.entries()) {
    const source = baseline.get(mutation.file);
    writeFileSync(mutation.file, mutation.transform(source));
    const result = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.workspace.ts", testPath, "-t", mutation.test], { encoding: "utf8", timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    writeFileSync(mutation.file, source);
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    writeFileSync(`${directory}/${mutation.name}.log`, output);
    const caught = result.status !== 0 && output.includes("FAIL ") && !output.includes("Failed to load") && !output.includes("Transform failed");
    results.push({ name: mutation.name, caught, status: result.status });
    writeFileSync(`${directory}/results.json`, JSON.stringify(results, null, 2) + "\n");
    console.log(`${index + 1}/${selected.length} ${mutation.name}: ${caught ? "caught" : "SURVIVED OR INVALID"}`);
  }
} finally {
  for (const [file, text] of baseline) writeFileSync(file, text);
}
assert.ok(results.every((result) => result.caught), "at least one mutation survived or failed outside the selected test; inspect results.json");
console.log(`PASS: all ${results.length} mutations were caught by their selected tests.`);
