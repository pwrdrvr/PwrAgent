import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// Every run uses the normal test bootstrap. Build/import/missing-owner failures
// never count. Sources are restored in finally, and protected hashes are checked.
const root = "apps/desktop/src/main/app-server/";
const tests = "apps/desktop/src/main/__tests__/";
const output = ".local/pwr-148/mutations";
mkdirSync(output, { recursive: true });
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(file => `${tests}fixtures/${file}`);
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = protectedFiles.map(digest);
for (const variable of ["UPDATE_TURN_EVENT_STREAM", "UPDATE_SQLITE_WRITE_BUDGETS"]) assert.notEqual(process.env[variable], "1");
function run(files, filter) {
  const result = spawnSync("pnpm", ["test", ...files.map(file => tests + file), ...(filter ? ["-t", filter] : [])], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, log: (result.stdout ?? "") + (result.stderr ?? "") };
}
if (process.argv.includes("--baseline")) {
  // Replays the final independent observable oracle on the unmodified pre-move
  // production tree, using this worktree's own installed dependencies.
  const base = "c56bff20ea68e785592b0c70e89e79cab8243ffa";
  const baselineFiles = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", base, root], { encoding: "utf8" }).trim().split("\n"));
  const files = execFileSync("git", ["diff", "--name-only", base, "--", root], { encoding: "utf8" }).trim().split("\n").filter(file => baselineFiles.has(file));
  const originals = new Map(files.map(file => [file, readFileSync(file, "utf8")]));
  let result;
  try {
    for (const file of files) writeFileSync(file, execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8" }));
    const testAt = process.argv.indexOf("--test");
    const baselineTests = testAt < 0 ? ["turn-event-observable.property.test.ts"] : [process.argv[testAt + 1]];
    result = run(baselineTests);
    writeFileSync(`${output}/${testAt < 0 ? "baseline" : "baseline-comparison"}.log`, result.log);
  } finally { for (const [file, original] of originals) writeFileSync(file, original); }
  assert.equal(result.status, 0, "Baseline oracle failed; inspect baseline.log");
  assert.deepEqual(protectedFiles.map(digest), hashes);
  console.log(JSON.stringify({ baselineOraclePassed: true, protectedFixturesUnchanged: true }));
  process.exit(0);
}
function enclosingMethod(node) {
  for (let p = node.parent; p; p = p.parent) if (ts.isMethodDeclaration(p)) return p.name.getText();
}
function replaceNode(source, file, predicate, replacement) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0);
  const matches = [];
  function visit(node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); }
  visit(ast);
  assert.equal(matches.length, 1, `Unique target in ${file}`);
  const node = matches[0];
  return source.slice(0, node.getStart(ast)) + (typeof replacement === "function" ? replacement(node) : replacement) + source.slice(node.end);
}
const focused = "turn-event-observers.test.ts";
const order = "turn-event-observer.property.test.ts";
const race = "codex-turn-terminal-ordering.property.test.ts";
const specs = [];
const mutation = (name, file, predicate, replacement, files = [focused], filter) => specs.push({ name, file, files, filter,
  rewrite: source => replaceNode(source, file, predicate, replacement) });
mutation("registration-order", "backend-registry-wiring.ts",
  node => ts.isArrayLiteralExpression(node) && ts.isVariableDeclaration(node.parent) && node.parent.name.getText() === "observers",
  node => { const items = node.elements.map(item => item.getText()); [items[0], items[1]] = [items[1], items[0]]; return `[${items.join(",\n")}]`; }, [order], "complete fixed domain order");
mutation("start-caller", "backend-registry-wiring.ts",
  node => ts.isCallExpression(node) && node.expression.getText() === "ports.observeTurnStarted", "undefined", [focused], "turn-started registers");
mutation("accounting-effect", "thread-usage-ledger.ts",
  node => ts.isCallExpression(node) && node.expression.getText() === "this.recordToolInvocationAccounting" && enclosingMethod(node) === "observeUsageAccounting", "undefined", [focused], "usage-accounting preserves");
mutation("forwarding-await", "managed-review-service.ts",
  node => ts.isAwaitExpression(node) && node.expression.getText() === "this.forwardManagedReviewActivity(event)",
  node => `void ${node.expression.getText()}`, [focused], "review-forwarding awaits");
mutation("pricing-finally", "thread-usage-ledger.ts",
  node => ts.isIfStatement(node) && node.expression.getText() === "terminalPricingChanged" && enclosingMethod(node) === "observeUsageTerminal",
  node => `if (false) ${node.thenStatement.getText()}`, [focused], "usage-terminal publishes written");
mutation("limit-host-port", "backend-registry.ts",
  node => ts.isCallExpression(node) && node.expression.getText() === "this.turnLimitObservation" && enclosingMethod(node) === "constructionPorts", "undefined", [focused], "replacement store methods");
mutation("late-store-port", "backend-registry-wiring.ts",
  node => ts.isGetAccessorDeclaration(node) && node.name.getText() === "completeThreadUsageTurn",
  "get completeThreadUsageTurn() { return undefined; }", [focused], "replacement store methods");
mutation("review-status-consumption", "backend-registry.ts",
  node => ts.isReturnStatement(node) && node.expression?.kind === ts.SyntaxKind.FalseKeyword && enclosingMethod(node) === "observeTurnStatus", "return;", [focused], "turn-status retires");
mutation("request-consumption", "backend-registry.ts",
  node => ts.isReturnStatement(node) && node.expression?.kind === ts.SyntaxKind.FalseKeyword && enclosingMethod(node) === "observeTurnRequestResolution", "return;", [focused], "request-resolution consumes");
mutation("review-outer-correlation", "managed-review-service.ts",
  node => ts.isVariableDeclaration(node) && node.name.getText() === "lifecycleTurnId" && enclosingMethod(node) === "observeReviewBoundary", "lifecycleTurnId = turnId", [focused], "review-boundary correlates");
mutation("workspace-caller", "thread-workspace-service.ts",
  node => ts.isCallExpression(node) && node.expression.getText() === "this.drainPendingThreadWorkspaceMovesForTerminalTurn" && enclosingMethod(node) === "turnEventObserver", "undefined", [focused], "workspace-boundary drains");
mutation("mcp-terminal-caller", "thread-mcp-connections.ts",
  node => ts.isCallExpression(node) && node.expression.getText() === "this.host().mcpGatewayTools?.cancel" && enclosingMethod(node) === "turnEventObserver", "undefined", [focused], "mcp-terminal cancels");
mutation("start-delivery-guard", "backend-registry.ts",
  node => ts.isVariableDeclaration(node) && node.name.getText() === "commitCodexStart", "commitCodexStart = true", [race], "start bookkeeping");
mutation("late-mode-registration", "backend-registry.ts",
  node => ts.isCallExpression(node) && node.expression.getText() === "this.context.turnState.resolveExecution",
  node => `this.context.turnState.acceptExecution(${node.arguments[0].getText()}, ${node.arguments[2].getText()})`, [race], "terminal ownership survives mode-read ordering");
mutation("observer-early-exit", "turn-event-observer.ts",
  node => ts.isReturnStatement(node) && !node.expression && enclosingMethod(node) === "run", "continue;", [order], "applicable handlers in order");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? undefined : new RegExp(process.argv[onlyAt + 1]);
const results = [];
for (const spec of specs.filter(spec => !only || only.test(spec.name))) {
  const file = root + spec.file, original = readFileSync(file, "utf8");
  let result;
  try { writeFileSync(file, spec.rewrite(original)); result = run(spec.files, spec.filter); }
  finally { writeFileSync(file, original); }
  writeFileSync(`${output}/${spec.name}.log`, result.log);
  const caught = result.status !== 0 && /AssertionError/.test(result.log)
    && !/Failed Suites|invalid signature|Cannot find module|Failed to resolve import|Transform failed|No test files found|TypeError|ReferenceError/.test(result.log);
  const summary = { mutation: spec.name, caught, status: result.status, log: `${output}/${spec.name}.log`,
    counterexample: result.log.match(/Counterexample:.*$/m)?.[0], replay: result.log.match(/\{ seed:.*$/m)?.[0] };
  results.push(summary);
  writeFileSync(`${output}/${spec.name}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(`${output}/results.json`, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  assert.deepEqual(protectedFiles.map(digest), hashes);
  assert.ok(caught, `Mutation ${spec.name} did not fail an assertion`);
}
assert.ok(results.length, "No mutation selected");
console.log(JSON.stringify({ mutations: results.length, caught: results.filter(result => result.caught).length, protectedFixturesUnchanged: true }));
