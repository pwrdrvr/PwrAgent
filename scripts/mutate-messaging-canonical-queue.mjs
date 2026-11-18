import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const baseline = "b13f0692db35f2809585e07aabc420c0abb7759d";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const directory = ".local/pwr-149-canonical-queue/mutations";
mkdirSync(directory, { recursive: true });
const protectedPaths = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(file => `${tests}fixtures/${file}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedBefore = protectedPaths.map(hash);
const baselineFiles = ["messaging-turn-admission.ts", "messaging-turn-state.ts", "messaging-controller.ts", "messaging-callback-handlers.ts",
  "messaging-callback-context.ts", "messaging-inbound-turns.ts", "messaging-inbound-context.ts", "messaging-backend-event-router.ts",
  "messaging-backend-event-context.ts", "messaging-adapter.ts", "messaging-inbound-helpers.ts"];
const files = [...baselineFiles, "messaging-queue-recoveries.ts"].map(file => core + file);
const originals = new Map(files.map(file => [file, readFileSync(file, "utf8")]));
const oracle = "messaging-canonical-queue-observable.property.test.ts";
const recovery = "messaging-queue-recoveries.property.test.ts";
const mutations = [
  ["owner-admission-skipped", "messaging-inbound-turns.ts", "      const started = await this.context.backend.startTurn({", "      throw new Error(\"Mutation refusal before admission\");\n      const started = await this.context.backend.startTurn({", oracle],
  ["input-lost", "messaging-inbound-turns.ts", "        input: params.input,", "        input: [],", oracle],
  ["wrong-owner", "messaging-inbound-turns.ts", "const started = await this.context.backend.startTurn({\n        backend: params.binding.backend,\n        federationTarget: federationTargetForBinding(params.binding),", "const started = await this.context.backend.startTurn({\n        backend: params.binding.backend,\n        federationTarget: undefined,", oracle],
  ["origin-lost", "messaging-inbound-turns.ts", "        messageOrigin: messageOriginForInboundEvent(params.event, startingOrigin?.source?.ref),", "        messageOrigin: undefined,", oracle],
  ["notice-registration-skipped", "messaging-inbound-turns.ts", "await this.context.host().applySharedQueueNoticeEvent(key, { type: \"accepted\", entry });", "void key;", oracle],
  ["notice-ready-skipped", "messaging-inbound-turns.ts", "await this.context.host().applySharedQueueNoticeEvent(key, { type: \"noticeReady\" });", "void key;", oracle],
  ["notice-ready-before-delivery", "messaging-inbound-turns.ts", "        try {\n          await this.context.host().deliverQueuedTurnNotice(entry);", "        try {\n          await this.context.host().applySharedQueueNoticeEvent(key, { type: \"noticeReady\" });\n          await this.context.host().deliverQueuedTurnNotice(entry);", oracle],
  ["observer-outcome-lost", "messaging-backend-event-router.ts", "type: \"ownerOutcome\", outcome: { status: turnQueueUpdate.status, turnId: turnQueueUpdate.turnId }", "type: \"noticeReady\"", oracle],
  ["claimed-input-visible", "messaging-queue-recoveries.ts", "state?.phase === \"held\" ? state.entry : undefined", "state && state.phase !== \"terminal\" ? state.entry : undefined", recovery],
  ["duplicate-claim", "messaging-queue-recoveries.ts", "state.phase === \"held\" ? { phase: \"retrying\", entry: state.entry, receipt: event.receipt } : state", "{ phase: \"retrying\", entry: state.entry, receipt: event.receipt }", recovery],
  ["failed-retry-retired", "messaging-queue-recoveries.ts", "event.accepted ? { phase: \"terminal\"", "true ? { phase: \"terminal\"", recovery],
  ["stale-settlement-accepted", "messaging-queue-recoveries.ts", "state.phase !== \"retrying\" || state.receipt !== event.receipt", "state.phase !== \"retrying\"", recovery],
  ["in-flight-cancel", "messaging-queue-recoveries.ts", "state.phase === \"held\" ? { phase: \"terminal\", entry: state.entry, outcome: \"cancelled\" } : state", "{ phase: \"terminal\", entry: state.entry, outcome: \"cancelled\" }", recovery],
  ["late-surface-revives-claim", "messaging-queue-recoveries.ts", "case \"surface\": return { ...state, entry:", "case \"surface\": return { phase: \"held\", entry:", recovery],
  ["terminal-record-leak", "messaging-queue-recoveries.ts", "this.states.delete(id);", "void id;", recovery],
  ["shutdown-retains-input", "messaging-queue-recoveries.ts", "for (const id of this.states.keys()) this.commit(id, { type: \"dispose\" });", "void this.states;", recovery],
  ["constructor-reads-clock", "messaging-queue-recoveries.ts", "constructor(private readonly context: { readonly now: () => number }) {}", "constructor(private readonly context: { readonly now: () => number }) { void context.now; }", recovery],
  ["caller-omits-cleanup", "messaging-controller.ts", "    this.queueRecoveries.dispose();", "    void this.queueRecoveries;", recovery],
  ["caller-uses-wrong-owner", "messaging-controller.ts", "get queueRecoveries() { return readController().queueRecoveries; }", "get queueRecoveries() { return new MessagingQueueRecoveries({ now: () => 1000 }); }", oracle],
];
function run(name, paths, shouldPass) {
  const log = `${directory}/${name}.log`, report = resolve(`${directory}/${name}.json`);
  const pattern = name === "caller-uses-wrong-owner" ? ["--testNamePattern=retains the owner\'s edited input"] : [];
  const fd = openSync(log, "w");
  let result;
  try { result = spawnSync("pnpm", ["test", ...paths.map(path => tests + path), ...pattern, "--reporter=default", "--reporter=json", `--outputFile=${report}`], { stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  if (result.error) throw result.error;
  const data = JSON.parse(readFileSync(report, "utf8"));
  const failed = data.testResults.flatMap(file => file.assertionResults).filter(test => test.status === "failed");
  const messages = failed.flatMap(test => test.failureMessages).join("\n");
  const output = readFileSync(log, "utf8");
  if (shouldPass ? result.status !== 0 || failed.length : result.status === 0 || !failed.length || !/AssertionError:/.test(output)
    || /TypeError|ReferenceError|Transform failed|Test timed out|Failed to (?:load|resolve|import)/.test(messages) || /(?:Caused by: )?(?:TypeError|ReferenceError):|Test timed out/.test(output)) {
    throw new Error(`${name}: invalid proof (exit=${result.status}, failed=${failed.length}); inspect ${log}`);
  }
  return { name, exit: result.status, failedAssertions: failed.length, passed: data.numPassedTests, log };
}
const results = [];
try {
  if (process.argv.includes("--baseline")) {
    for (const file of baselineFiles) writeFileSync(core + file, execFileSync("git", ["show", `${baseline}:${core + file}`]));
    results.push(run("original-observable", [oracle, "messaging-turn-observable.property.test.ts"], true));
    results.push(run("original-counterexamples", ["messaging-canonical-queue-counterexample.property.test.ts"], false));
  } else {
    for (const [name, file, from, to, test] of mutations) {
      const path = core + file, source = originals.get(path);
      if (source.split(from).length !== 2) throw new Error(`${name}: expected one mutation site`);
      writeFileSync(path, source.replace(from, to));
      try { const result = run(name, [test], false); results.push(result); console.log(JSON.stringify(result)); }
      finally { writeFileSync(path, source); }
    }
  }
} finally {
  for (const [file, source] of originals) writeFileSync(file, source);
  if (protectedPaths.some((file, index) => hash(file) !== protectedBefore[index])) throw new Error("Protected fixture changed");
  writeFileSync(`${directory}/${process.argv.includes("--baseline") ? "baseline-summary" : "mutation-summary"}.json`, JSON.stringify({ baseline, results, protectedBefore }, null, 2) + "\n");
}
console.log(JSON.stringify({ baseline, proofs: results.length, protectedUnchanged: true }));
