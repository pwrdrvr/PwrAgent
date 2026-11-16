import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// Run after selecting this checkout's Node and installing its dependencies.
// --legacy replays the pre-phase-4 guard mutation against main 93caf4eb0.
// --only <pattern> selects individual mutations without changing their tests.
// Every source mutation is restored in finally. Build/import failures do not
// count as detection: the selected test must fail an actual assertion.
const directory = ".local/pwr-147/mutations";
mkdirSync(directory, { recursive: true });
const root = "apps/desktop/src/main/app-server/";
const tests = "apps/desktop/src/main/__tests__/";
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(name => `${tests}fixtures/${name}`);
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedDigests = protectedFiles.map(digest);
for (const variable of ["UPDATE_TURN_EVENT_STREAM", "UPDATE_SQLITE_WRITE_BUDGETS"]) assert.notEqual(process.env[variable], "1", variable);
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex < 0 ? undefined : new RegExp(process.argv[onlyIndex + 1]);

function enclosing(node, predicate) {
  for (let parent = node.parent; parent; parent = parent.parent) if (predicate(parent)) return parent;
}
const method = node => enclosing(node, ts.isMethodDeclaration)?.name.getText();
const branch = node => enclosing(node, ts.isCaseClause)?.expression.text;
function replaceNode(text, file, predicate, replacement) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0, file);
  const matches = [];
  function visit(node) {
    if (predicate(node, ast)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, `Unique mutation target in ${file}`);
  const node = matches[0];
  return text.slice(0, node.getStart(ast)) + (typeof replacement === "function" ? replacement(node, ast) : replacement) + text.slice(node.getEnd());
}
const reducer = "codex-thread-activity.ts";
const registry = "backend-registry.ts";
const model = "codex-thread-activity.property.test.ts";
const owner = "registry-turn-state.property.test.ts";
const terminal = "codex-turn-terminal-ordering.property.test.ts";
const specs = [];
function mutation(name, file, predicate, replacement, files, filter) {
  specs.push({ name, file, rewrite: text => replaceNode(text, `${root}${file}`, predicate, replacement), files, filter });
}

if (process.argv.includes("--legacy")) {
  mutation("legacy-terminal-guard", registry,
    node => ts.isIfStatement(node) && node.expression.getText().includes('this.activeTurnKeys.has(buildActiveTurnKey("codex", notification.params.threadId, turnId))'),
    node => `if (true) ${node.thenStatement.getText()}`, [terminal], "terminal ownership survives mode-read ordering");
} else {
  mutation("review-child-query-contract", "registry-turn-state.ts",
    node => ts.isReturnStatement(node) && method(node) === "reviewChildParent",
    "return this.reviewActivities().flatMap(({ state }) => state.reviewChildren).find(link => link.key === key);", [owner], "previous lookup identity");
  mutation("review-child-link-identity", "registry-turn-state.ts",
    node => ts.isPropertyAssignment(node) && node.name.getText() === "link" && method(node) === "linkReviewChild",
    "link: { key, ...parent }", [owner], "previous lookup identity");
  mutation("origin-field-isolation", reducer,
    node => ts.isPropertyAssignment(node) && node.name.getText() === "value" && branch(node) === "originBound",
    "value: { ...origin.value, ...event.turn }", [owner], "binds causal origins");
  mutation("review-view-invalidation", "registry-turn-state.ts",
    node => ts.isBinaryExpression(node) && node.left.getText() === "this.cachedReviewProjection" && method(node) === "invalidateReviewProjection",
    "undefined", [owner], "immutable review views");
  mutation("listener-start-receipt", registry,
    node => ts.isCallExpression(node) && node.expression.getText() === "this.context.turnState.beginStartDelivery" && method(node) === "subscribeClient",
    "undefined", [terminal], "first listener await|listener bookkeeping before emit");
  mutation("late-bookkeeping-caller", registry,
    node => ts.isVariableDeclaration(node) && node.name.getText() === "commitCodexStart",
    "commitCodexStart = true", [terminal], "start bookkeeping");
  mutation("delivery-claim-check", reducer,
    node => ts.isIfStatement(node) && branch(node) === "announced" && node.expression.getText().includes("event.delivery"),
    node => `if (false) ${node.thenStatement.getText()}`, [owner], "correlates pending notification delivery");
  mutation("delivery-terminal-observation", reducer,
    node => ts.isReturnStatement(node) && ts.isCaseClause(node.parent) && branch(node) === "terminalDelivery",
    "return state;", [owner], "correlates pending notification delivery");
  mutation("delivery-disposal", reducer,
    node => ts.isReturnStatement(node) && ts.isCaseClause(node.parent) && branch(node) === "finishDelivery",
    "return state;", [owner], "correlates pending notification delivery");
  mutation("reservation-borrowed-token", "registry-turn-state.ts",
    node => ts.isReturnStatement(node) && method(node) === "reserveStart",
    "return this.codex(threadId).reservation!.owner;", [owner], "competing reservation");
  mutation("native-review-pending-caller", "managed-review-service.ts",
    node => ts.isCallExpression(node) && node.expression.getText() === "this.context.turnState.pendingStartedTurnId",
    "undefined", [terminal], "native review terminal owns a pending inner start delivery");
  mutation("late-mode-ownership", reducer,
    node => ts.isIfStatement(node) && node.expression.getText().includes('event.type === "executionResolved"'),
    node => `if (false) ${node.thenStatement.getText()}`, [model, terminal], "known terminal-before-mode|terminal ownership survives mode-read ordering");
  mutation("turn-receipt-correlation", reducer,
    node => ts.isBinaryExpression(node) && node.getText() === "turn.registration !== event.registration",
    "false", [model], "correlates a delayed mode");
  mutation("reservation-owner", reducer,
    node => ts.isBinaryExpression(node) && node.getText() === "state.reservation?.owner === event.owner",
    "true", [model], "intended legacy projection");
  mutation("status-high-water", reducer,
    node => ts.isBinaryExpression(node) && node.getText() === "event.observation.sequence < state.statusWatermark",
    "false", [model], "intended legacy projection");
  mutation("acknowledged-watermark", reducer,
    node => ts.isCallExpression(node) && node.expression.getText() === "classify" && branch(node) === "acknowledgeObservation",
    "classify({ ...state, observation: undefined, statusWatermark: 0 })", [owner], "synthetic start observation");
  mutation("newer-observation", reducer,
    node => ts.isBinaryExpression(node) && node.getText() === "state.observation?.sequence !== event.sequence",
    "false", [owner], "synthetic start observation");
  mutation("review-admission-finality", reducer,
    node => ts.isIfStatement(node) && node.expression.getText() === "!allowed",
    node => `if (false) ${node.thenStatement.getText()}`, [owner], "review admission outcomes final");
  mutation("review-start-evidence", reducer,
    node => ts.isReturnStatement(node) && ts.isCaseClause(node.parent) && branch(node) === "reviewTerminal",
    "return state;", [owner, terminal], "review admission outcomes final|native review release retains terminal evidence");
  mutation("review-evidence-caller", "managed-review-service.ts",
    node => ts.isCallExpression(node) && node.expression.getText() === "this.context.turnState.recordReviewTerminal",
    "undefined", [terminal], "native review release retains terminal evidence");
  mutation("mode-completion-caller", registry,
    node => ts.isCallExpression(node) && node.expression.getText() === "this.context.turnState.resolveExecution",
    node => `this.context.turnState.acceptExecution(${node.arguments[0].getText()}, ${node.arguments[2].getText()})`,
    [terminal], "terminal ownership survives mode-read ordering");
  mutation("registry-admission-caller", registry,
    node => ts.isCallExpression(node) && node.expression.getText() === "this.context.turnState.hasActiveTurn",
    "false", [owner], "routes registry admission");
  mutation("registry-host-port", registry,
    node => ts.isCallExpression(node) && node.expression.getText() === "this.threadHasActiveTurn" && method(node) === "constructionPorts",
    "false", [owner], "routes registry admission");
  mutation("supervisor-status-reader", "codex-runtime-supervisor.ts",
    node => ts.isPropertyAccessExpression(node) && node.name.text === "providerActiveCount",
    "0", ["codex-runtime-supervisor.test.ts"], "restarts exactly at an open");
  mutation("supervisor-exit-receipt", "codex-runtime-supervisor.ts",
    node => ts.isPropertyAssignment(node) && node.name.getText() === "terminalObserved" && method(node) === "handleCodexAppServerUnexpectedExit",
    "terminalObserved: false", [owner], "accepted compactions owned by an exited process");
  mutation("forge-collaboration-reader", "forge-tool-bridge.ts",
    node => ts.isCallExpression(node) && node.expression.getText() === "this.context.turnState.collaborationMode" && ts.isObjectLiteralExpression(node.arguments[0]),
    "undefined", ["forge-tool-bridge.test.ts"], "refuses every write in a Codex plan turn");
  mutation("wiring-owner-identity", "backend-registry-wiring.ts",
    node => ts.isPropertyAssignment(node) && node.name.getText() === "turnState" && ts.isNewExpression(node.initializer),
    "get turnState() { return new RegistryTurnState(); }", [owner], "routes registry admission");
  mutation("origin-binding", reducer,
    node => ts.isReturnStatement(node) && ts.isCaseClause(node.parent) && branch(node) === "originBound",
    "return state;", [owner], "binds causal origins");
  specs.push({ name: "subscriber-commit-order", file: "registry-turn-state.ts", files: [owner], filter: "commits before notifying turn waiters",
    rewrite: text => replaceNode(text, `${root}registry-turn-state.ts`, node => ts.isMethodDeclaration(node) && node.name.getText() === "transition", node => {
      const source = node.getText();
      assert.equal(source.split("this.commitCodexActivity(threadId, previous, next);").length, 2);
      return source.replace("this.commitCodexActivity(threadId, previous, next);", "").replace(/\}\s*$/, "this.commitCodexActivity(threadId, previous, next);\n  }");
    }),
  });
}

const results = [];
for (const spec of specs.filter(spec => !only || only.test(spec.name))) {
  const file = root + spec.file;
  const original = readFileSync(file, "utf8");
  let result;
  try {
    writeFileSync(file, spec.rewrite(original));
    result = spawnSync("pnpm", ["test", ...spec.files.map(file => tests + file), "-t", spec.filter], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(`${directory}/${spec.name}.log`, (result.stdout ?? "") + (result.stderr ?? ""));
  } finally {
    writeFileSync(file, original);
  }
  const log = (result?.stdout ?? "") + (result?.stderr ?? "");
  const caught = result?.status !== 0 && /AssertionError/.test(log)
    && !/Failed Suites|invalid signature|Cannot find module|Failed to resolve import|Transform failed|No test files found|TypeError|ReferenceError/.test(log);
  const summary = { mutation: spec.name, caught, status: result?.status,
    counterexample: log.match(/Counterexample:.*$/m)?.[0], replay: log.match(/\{ seed:.*$/m)?.[0], log: `${directory}/${spec.name}.log` };
  results.push(summary);
  writeFileSync(`${directory}/${spec.name}.json`, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  assert.ok(caught, `Mutation ${spec.name} was not caught by an assertion; inspect its log`);
  assert.deepEqual(protectedFiles.map(digest), protectedDigests, "Protected fixtures changed");
}
assert.ok(results.length, "At least one mutation selected");
writeFileSync(`${directory}/results.json`, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ mutations: results.length, caught: results.filter(result => result.caught).length, protectedFixturesUnchanged: true }));
