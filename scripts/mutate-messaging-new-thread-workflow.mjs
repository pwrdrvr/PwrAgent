import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const baseline = "2b8f0ce2d2afdfd3f836dd35f5b8258537955d74";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const directory = ".local/pwr-149-new-thread-workflow/mutations";
mkdirSync(directory, { recursive: true });
const files = ["messaging-controller.ts", "messaging-new-thread-workflow.ts", "messaging-new-thread-context.ts", "messaging-callback-helpers.ts"];
const originals = new Map(files.map(file => [file, readFileSync(core + file, "utf8")]));
const protectedPaths = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(file => `${tests}fixtures/${file}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedBefore = protectedPaths.map(hash);
const mutations = [
  ["unavailable-provider-admitted", files[1], "selectableNewThreadBackends(response.backends)", "response.backends", "revalidates provider availability"],
  ["preferred-provider-ignored", files[1], "if (params.requirePreferred)", "if (false)", "keeps provider and launch"],
  ["settings-not-persisted-before-delivery", files[1], "await this.context.store.upsertBrowseSession(effectiveSession);", "// mutation: skip pre-delivery state", "persists selected settings"],
  ["surface-not-committed", files[1], "branchName: options.workMode === \"worktree\" ? options.branchName : undefined,\n      surface: result.surface,", "branchName: options.workMode === \"worktree\" ? options.branchName : undefined,\n      surface: effectiveSession.surface,", "persists selected settings"],
  ["full-access-gate-bypassed", files[1], "if (executionMode === \"full-access\")", "if (false)", "does not write or apply"],
  ["acp-risk-gate-bypassed", files[1], "choice.privileged &&\n      !messagingAcpRuntimeValueLooksPrivileged(currentRuntimeMode.currentValue)", "false", "requires the runtime risk gate"],
  ["remote-sticky-write-not-guarded", files[1], "if (session.selectedProject?.federationTarget?.scope === \"remote\") return;", "// mutation: remove remote guard", "keeps remote choices local"],
  ["discovery-getter-moved-outside-catch", files[1], "    try {\n      const response = await this.context.backend.listBackends?.({", "    void this.context.backend.listBackends;\n    try {\n      const response = await this.context.backend.listBackends?.({", "keeps discovery getters"],
  ["constructor-reads-host", files[1], "constructor(private readonly context: MessagingNewThreadContext) {}", "constructor(private readonly context: MessagingNewThreadContext) { void context.host; }", "constructs without reading"],
  ["facade-captures-store", files[0], "this.newThreadWorkflow = new MessagingNewThreadWorkflow({\n      get store() { return readStore(); },", "this.newThreadWorkflow = new MessagingNewThreadWorkflow({\n      store: readStore(),", "reads the replacement wrapped store"],
  ["facade-loses-clock-receiver", files[0], "      get pendingIntentTtlMs() { return readPendingIntentTtl(); },\n      get streamingResponsesDefault() { return readStreamingDefault(); },\n      now: () => this.now(),", "      get pendingIntentTtlMs() { return readPendingIntentTtl(); },\n      get streamingResponsesDefault() { return readStreamingDefault(); },\n      get now() { return readNow(); },", "preserves the controller clock receiver"],
  ["caller-drops-project-selection", files[0], "this.newThreadWorkflow.startNewThreadFromProject(...args)", "Promise.resolve()", "keeps provider and launch"],
  ["caller-drops-model-picker", files[0], "this.newThreadWorkflow.presentNewThreadModelPicker(...args)", "Promise.resolve()", "keeps provider and launch"],
  ["branch-page-reserves-too-few-actions", files[1], "navActionCountMultipage: 4,", "navActionCountMultipage: 3,", "reaches later base-branch pages"],
  ["capture-expiry-does-not-advance", files[1], "this.context.now() + NEW_THREAD_PROMPT_CAPTURE_TTL_MS", "this.context.now() - NEW_THREAD_PROMPT_CAPTURE_TTL_MS", "constructs without reading"],
  ["nullable-string-drops-null", files[3], "if (result === null) {\n    return null;", "if (result === null) {\n    return undefined;", "accepts only declared access/runtime"]
];
function run(name, shouldPass, pattern) {
  const log = `${directory}/${name}.log`;
  const report = resolve(`${directory}/${name}.json`);
  const fd = openSync(log, "w");
  let result;
  const paths = ["messaging-new-thread-observable.property.test.ts", ...(shouldPass ? [] : ["messaging-new-thread-workflow.test.ts", "messaging-callback-helpers.property.test.ts"])];
  try {
    result = spawnSync("pnpm", ["test", ...paths.map(path => tests + path), ...(pattern ? [`--testNamePattern=${pattern}`] : []),
      "--reporter=default", "--reporter=json", `--outputFile=${report}`], { stdio: ["ignore", fd, fd] });
  } finally { closeSync(fd); }
  if (result.error) throw result.error;
  const data = JSON.parse(readFileSync(report, "utf8"));
  const failed = data.testResults.flatMap(file => file.assertionResults).filter(test => test.status === "failed");
  const output = readFileSync(log, "utf8");
  const messages = failed.flatMap(test => test.failureMessages).join("\n");
  if (shouldPass ? result.status !== 0 || failed.length : result.status === 0 || !failed.length || !/AssertionError:/.test(output)
    || /TypeError|ReferenceError|Transform failed|Test timed out|Failed to (?:load|resolve|import)/.test(messages)
    || /(?:Caused by: )?(?:TypeError|ReferenceError):|Test timed out/.test(output)) {
    throw new Error(`${name}: invalid observable proof; inspect ${log}`);
  }
  const proof = { name, exit: result.status, failedAssertions: failed.length, passed: data.numPassedTests, log };
  console.log(JSON.stringify(proof));
  return proof;
}
const results = [];
const original = process.argv.includes("--baseline");
try {
  if (original) {
    writeFileSync(core + files[0], execFileSync("git", ["show", `${baseline}:${core + files[0]}`]));
    results.push(run("original-observable", true));
  } else {
    for (const [name, file, from, to, pattern] of mutations) {
      const source = originals.get(file);
      if (source.split(from).length !== 2) throw new Error(`${name}: expected one mutation site`);
      writeFileSync(core + file, source.replace(from, to));
      try { results.push(run(name, false, pattern)); }
      finally { writeFileSync(core + file, source); }
    }
  }
} finally {
  for (const [file, source] of originals) writeFileSync(core + file, source);
  if (protectedPaths.some((file, index) => hash(file) !== protectedBefore[index])) throw new Error("Protected fixture changed");
  writeFileSync(`${directory}/${original ? "baseline" : "mutation"}-summary.json`,
    JSON.stringify({ baseline, results, protectedBefore }, null, 2) + "\n");
}
