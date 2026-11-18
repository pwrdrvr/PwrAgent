import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const baseline = "a473f7b70baf2ae2e7bcbecb4a27be5b9e7852b9";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const owner = `${core}messaging-turn-state.ts`;
const facade = `${core}messaging-controller.ts`;
const router = `${core}messaging-backend-event-router.ts`;
const inbound = `${core}messaging-inbound-turns.ts`;
const production = [facade, router, inbound, `${core}messaging-backend-event-context.ts`, `${core}messaging-inbound-context.ts`];
const original = new Map([...production, owner].map(file => [file, readFileSync(file, "utf8")]));
const directory = ".local/pwr-149-turn-state/mutations";
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(file => `${tests}fixtures/${file}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = protectedFiles.map(hash);
const pure = "messaging-turn-state.property.test.ts";
const observable = "messaging-turn-observable.property.test.ts";
const regression = "messaging-turn-late-acceptance.property.test.ts";
const mutations = [
  ["late-acceptance", owner, "if (state.activeTurn?.turnId === event.turn.turnId", "if (false && state.activeTurn?.turnId === event.turn.turnId", regression],
  ["automation-isolation", owner, "event.lifecycle && !event.automation ? event.lifecycle", "event.lifecycle ? event.lifecycle", pure, "projects provider lifecycle"],
  ["duplicate-status", owner, "const changed = turn && (turn.turnId !== previousTurn?.turnId || turn.status !== previousTurn.status);", "const changed = Boolean(turn);", pure, "projects provider lifecycle"],
  ["idle-evidence", owner, 'status: "completed" as const, updatedAt: event.now', 'status: "working" as const, updatedAt: event.now', pure, "projects provider lifecycle"],
  ["request-retention", owner, 'state: { ...state, drainRequested: true }', 'state: { ...state, drainRequested: false }', pure, "models coalescing"],
  ["request-consumption", owner, 'state: { ...state, drainRequested: false }, effects: state.drainRequested', 'state: { ...state, drainRequested: true }, effects: state.drainRequested', pure, "models coalescing"],
  ["drain-coalescing", owner, 'if (!event.eligible || next.drain.phase !== "idle")', 'if (!event.eligible)', pure, "models coalescing"],
  ["dispatch-effect", owner, 'effects: [{ type: "dispatch", receipt: state.drain.receipt }]', 'effects: []', pure, "models coalescing"],
  ["stale-settlement", owner, '|| state.drain.receipt.token !== event.token) return unchanged;\n      return { state: { ...state, drain: { phase: "idle" } }', ') return unchanged;\n      return { state: { ...state, drain: { phase: "idle" } }', pure, "models coalescing"],
  ["shutdown-cancel", owner, 'effects: state.drain.phase === "scheduled" ? [{ type: "cancel", receipt: state.drain.receipt }] : []', 'effects: []', pure, "models coalescing"],
  ["shutdown-running", owner, ' : state.drain },', ' : { phase: "idle" } },', pure, "models coalescing"],
  ["macrotask-boundary", owner, 'const timer = setTimeout(() => {', 'void this.context.host().startNextQueuedTurn(binding);\n      const timer = setTimeout(() => {', observable, "cancels an armed drain"],
  ["settlement-await", owner, 'await Promise.allSettled(drains);', 'void Promise.allSettled(drains);', observable, "settles a running drain"],
  ["late-host", owner, 'const timer = setTimeout(() => {', 'const captured = this.context.host();\n      const timer = setTimeout(() => {', pure, "reads no collaborators", ['this.context.host().startNextQueuedTurn(binding).catch', 'captured.startNextQueuedTurn(binding).catch']],
  ["constructor-host", owner, 'constructor(private readonly context: MessagingTurnStateContext) {}', 'constructor(private readonly context: MessagingTurnStateContext) { context.host(); }', pure, "reads no collaborators"],
  ["facade-drain-port", facade, 'get turnAdmission() { return readTurnAdmission(); },\n        startNextQueuedTurn: (...args) => this.startNextQueuedTurn(...args),', 'get turnAdmission() { return readTurnAdmission(); },\n        startNextQueuedTurn: async () => {},', observable, "starts queued inputs"],
  ["facade-schedule-caller", facade, 'this.turns.schedule(binding);', 'void binding;', observable, "starts queued inputs"],
  ["facade-observation-port", facade, 'observeBackendTurn: (...args) => this.turns.observeBackend(...args),', 'observeBackendTurn: () => ({ changed: false }),', regression],
  ["acceptance-caller", inbound, 'this.context.host().acceptStartedTurn(deliveryBinding, activeTurn);', 'this.context.host().setActiveTurn(deliveryBinding, activeTurn);', regression],
  ["terminal-order", router, 'await this.context.host().flushToolUpdatesForBinding(binding, {', 'void this.context.host().flushToolUpdatesForBinding(binding, {', "messaging-backend-event-router.test.ts", "awaits terminal cleanup"],
];
function changed(name, file, before, after, _test, _pattern, second) {
  let text = original.get(file);
  for (const [from, to] of [[before, after], ...(second ? [second] : [])]) {
    if (!text.includes(from) || text.indexOf(from) !== text.lastIndexOf(from)) throw new Error(`Non-unique mutation anchor: ${name}`);
    text = text.replace(from, to);
  }
  return text;
}
function restore() {
  for (const [file, text] of original) writeFileSync(file, text);
  protectedFiles.forEach((file, index) => { if (hash(file) !== hashes[index]) throw new Error(`Protected fixture changed: ${file}`); });
}
mkdirSync(directory, { recursive: true });
if (process.argv.includes("--check")) {
  mutations.forEach(mutation => changed(...mutation));
  console.log(JSON.stringify({ anchorsVerified: mutations.length }));
  process.exit(0);
}
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const results = [];
function run(name, files, shouldPass, pattern) {
  const result = spawnSync("pnpm", ["test", ...files.map(file => tests + file), ...(pattern ? ["-t", pattern] : [])], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(`${directory}/${name}.log`, log);
  const assertions = /AssertionError/.test(log);
  const invalid = /TypeError|SyntaxError|ReferenceError|Failed to load|Cannot find module|Cannot read properties|is not a function|invalid signature|timed out|No test files found/.test(log);
  const passed = shouldPass ? result.status === 0 : result.status !== 0 && assertions && !invalid;
  const evidence = { name, status: result.status, assertions, invalid, passed };
  console.log(JSON.stringify(evidence)); results.push(evidence);
}
try {
  if (process.argv.includes("--baseline")) {
    for (const file of production) writeFileSync(file, execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
    run("original-main-observable", [observable, "messaging-inbound-observable.property.test.ts"], true);
    run("original-main-late-acceptance-counterexample", [regression], false);
  } else {
    run("current-production", [pure, observable, regression, "messaging-backend-event-router.test.ts"], true);
    for (const mutation of mutations) {
      if (only && !mutation[0].includes(only)) continue;
      writeFileSync(mutation[1], changed(...mutation));
      try { run(mutation[0], [mutation[4]], false, mutation[5]); } finally { restore(); }
    }
  }
} finally {
  restore();
  writeFileSync(`${directory}/results${process.argv.includes("--baseline") ? "-baseline" : only ? `-${only}` : ""}.json`, JSON.stringify(results, null, 2) + "\n");
}
console.log(JSON.stringify({ baseline, attempted: results.length, passed: results.filter(result => result.passed).length, protectedFixturesUnchanged: true }));
if (!results.length || results.some(result => !result.passed)) process.exitCode = 1;
