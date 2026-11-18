import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const baseline = "57f22e49688dd64c3bd27c791516ad730a6117dd";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const directory = ".local/pwr-149-review-workflow/mutations";
mkdirSync(directory, { recursive: true });
const files = ["messaging-controller.ts", "messaging-review-workflow.ts", "messaging-review-context.ts"];
const originals = new Map(files.map(file => [file, readFileSync(core + file, "utf8")]));
const protectedPaths = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(file => `${tests}fixtures/${file}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedBefore = protectedPaths.map(hash);
const mutations = [
  ["review-target-lost", files[1], "        target: params.target,", '        target: { type: "uncommittedChanges" },', "direct review commands"],
  ["pending-retired-before-acceptance", files[1], "      const result = await submitReview({",
    "      if (params.pendingIntentId) await this.context.store.deletePendingIntent(params.pendingIntentId);\n      const result = await submitReview({", "keeps the pending picker"],
  ["submission-receiver-lost", files[1], "this.context.backend.submitReview?.bind(\n      this.context.backend,\n    )", "this.context.backend.submitReview", "direct review commands"],
  ["mode-downgrade-admitted", files[1], "if (params.runMode !== undefined)", "if (false)", "downgraded modes"],
  ["auto-fix-downgrade-admitted", files[1], 'if (afterReview === "auto-fix" && owner?.capabilities.reviewAutoFix !== true)', "if (false)", "downgraded autoFix"],
  ["previous-provider-model-retained", files[1], "reviewer: { backend },", "reviewer: { ...current, backend },", "uses only the selected provider"],
  ["workspace-page-overflow", files[1], "Math.max(1, maxActions - 4)", "Math.max(1, maxActions - 3)", "reaches later workspace pages"],
  ["updated-surface-lost", files[1], "...pendingIntent,\n      intent,\n      surface: result.surface ?? pendingIntent.surface,",
    "...pendingIntent,\n      intent,\n      surface: pendingIntent.surface,", "models target"],
  ["constructor-reads-host", files[1], "constructor(private readonly context: MessagingReviewContext) {}",
    "constructor(private readonly context: MessagingReviewContext) { void context.host; }", "constructs without reading"],
  ["facade-captures-initial-store", files[0], "this.reviewWorkflow = new MessagingReviewWorkflow({\n      get store() { return readStore(); },",
    "this.reviewWorkflow = new MessagingReviewWorkflow({\n      store: readStore(),", "keeps the pending picker"],
  ["clock-port-loses-receiver", files[0], "this.reviewWorkflow = new MessagingReviewWorkflow({\n      get store() { return readStore(); },\n      get backend() { return readBackend(); },\n      get capabilityProfile() { return readCapabilityProfile(); },\n      now: () => this.now(),",
    "this.reviewWorkflow = new MessagingReviewWorkflow({\n      get store() { return readStore(); },\n      get backend() { return readBackend(); },\n      get capabilityProfile() { return readCapabilityProfile(); },\n      get now() { return readNow(); },", "preserves the controller clock receiver"],
  ["callback-caller-drops-action", files[0], "this.reviewWorkflow.handleReviewAction(...args)", "Promise.resolve()", "models target"],
  ["command-caller-drops-picker", files[0], "this.reviewWorkflow.presentReviewPicker(...args)", "Promise.resolve()", "models target"],
  ["list-getter-outside-catch", files[1], "    try {\n      const response = await this.context.backend.listBackends?.({",
    "    void this.context.backend.listBackends;\n    try {\n      const response = await this.context.backend.listBackends?.({", "reads list and summary getters"],
];
function run(name, shouldPass, pattern) {
  const log = `${directory}/${name}.log`;
  const report = resolve(`${directory}/${name}.json`);
  const fd = openSync(log, "w");
  let result;
  const paths = ["messaging-review-observable.property.test.ts", ...(shouldPass ? [] : ["messaging-review-workflow.test.ts"])];
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
