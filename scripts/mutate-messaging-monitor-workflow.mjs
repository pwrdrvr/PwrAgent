import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const baseline = "e64dc010dbc05e5875affc8932eb8faa38c78af5";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const directory = ".local/pwr-149-monitor-workflow/mutations";
mkdirSync(directory, { recursive: true });
const files = ["messaging-controller.ts", "messaging-monitor-workflow.ts", "messaging-monitor-context.ts", "messaging-monitor-helpers.ts"];
const originals = new Map(files.map(file => [file, readFileSync(core + file, "utf8")]));
const protectedPaths = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(file => `${tests}fixtures/${file}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedBefore = protectedPaths.map(hash);
// Optional method names restrict a mutation to one actual production body.
const mutations = [
  ["constructor-reads-host", files[1], "constructor(private readonly context: MessagingMonitorContext) {}", "constructor(private readonly context: MessagingMonitorContext) { void context.host; }", "constructs without reading"],
  ["facade-captures-store", files[0], "this.monitorWorkflow = new MessagingMonitorWorkflow({\n      get store() { return readStore(); },", "this.monitorWorkflow = new MessagingMonitorWorkflow({\n      store: readStore(),", "uses the replacement wrapped store"],
  ["clock-receiver-lost", files[0], "get config() { return readMonitorConfig(); },\n      now: () => this.now(),", "get config() { return readMonitorConfig(); },\n      get now() { return readNow(); },", "uses the replacement wrapped store"],
  ["startup-caller-dropped", files[0], "await this.monitorWorkflow.startMonitoringForEnabledBindings();", "return;", "routes startup to the actual owner"],
  ["disposal-caller-dropped", files[0], "this.monitorWorkflow.dispose();", "// mutation: omit timer disposal", "disposes bound and subscription"],
  ["disposed-subscription-rearmed", files[1], "this.context.disposed ||", "false ||", "does not rearm timers", "scheduleMonitorSubscriptionTick"],
  ["subscription-timer-duplicated", files[1], "this.monitorTimersBySubscriptionId.has(subscription.id)", "false", "routes startup to the actual owner", "scheduleMonitorSubscriptionTick"],
  ["permanent-target-not-retired", files[1], "if (isPermanentMessagingTargetFailure(result))", "if (false)", "retries transient delivery"],
  ["transient-retry-not-scheduled", files[1], "if (latest && !latest.revokedAt && latest.monitor.enabled)", "if (false)", "keeps bounded selections", "runMonitorSubscriptionTick"],
  ["passive-read-counts-as-activity", files[1], "{ countsAsActivity: false }", "{ countsAsActivity: true }", "keeps passive timer reads", "resolveMonitorActiveTurns"],
  ["query-receiver-lost", files[1], "this.context.backend.getNavigationQueryPage?.bind(this.context.backend)", "this.context.backend.getNavigationQueryPage", "keeps bounded selections"],
  ["row-page-size-ignored", files[1], "pageSize: section.size", "pageSize: 1", "keeps bounded selections"],
  ["recent-query-uses-pins", files[1], "pinned: \"exclude\" as const", "pinned: \"include\" as const", "keeps bounded selections"],
  ["cleanup-action-cap-exceeded", files[1], ".slice(0, 6)", ".slice(0, 7)", "persists cleanup proposals"],
  ["fanout-cap-exceeded", files[1], ".threads.slice(0, 3)", ".threads.slice(0, 4)", "creates only the bounded topic fanout"],
  ["fanout-link-reuse-dropped", files[1], "if (existing)", "if (false)", "creates only the bounded topic fanout", "runTopicMonitorFanout"],
  ["host-binds-wrong-thread", files[0], "this.bindingService.bindChannelToThread(...args)", "this.bindingService.bindChannelToThread(args[0], { ...args[1], threadId: \"wrong-fixture-thread\" })", "creates only the bounded topic fanout", "monitorHost"],
  ["cleanup-prelude-skipped", files[1], "await this.context.host().cleanupExpiredPrivateReplyContinuations();", "// mutation: omit startup prelude", "awaits continuation cleanup"],
  ["limit-cycle-does-not-advance", files[3], "nextMonitorThreadLimit(currentPinned)", "currentPinned", "cycles independently specified"],
];
function run(name, shouldPass, pattern) {
  const log = `${directory}/${name}.log`;
  const report = resolve(`${directory}/${name}.json`);
  const fd = openSync(log, "w");
  const paths = ["messaging-monitor-observable.property.test.ts", ...(shouldPass ? [] : ["messaging-monitor-workflow.test.ts", "messaging-monitor-helpers.property.test.ts"])];
  let result;
  try {
    result = spawnSync("pnpm", ["test", ...paths.map(path => tests + path), ...(pattern ? [`--testNamePattern=${pattern}`] : []),
      "--reporter=default", "--reporter=json", `--outputFile=${report}`], { stdio: ["ignore", fd, fd] });
  } finally { closeSync(fd); }
  if (result.error) throw result.error;
  const data = JSON.parse(readFileSync(report, "utf8"));
  const failed = data.testResults.flatMap(file => file.assertionResults).filter(test => test.status === "failed");
  const messages = failed.flatMap(test => test.failureMessages).join("\n");
  const output = readFileSync(log, "utf8");
  if (shouldPass ? result.status !== 0 || failed.length : result.status === 0 || !failed.length || !/AssertionError:/.test(output)
    || /TypeError|ReferenceError|Transform failed|Test timed out|Failed to (?:load|resolve|import)/.test(messages)
    || /(?:Caused by: )?(?:TypeError|ReferenceError):|Test timed out/.test(output)) throw new Error(`${name}: invalid assertion proof; inspect ${log}`);
  const proof = { name, exit: result.status, failedAssertions: failed.length, passed: data.numPassedTests, log };
  console.log(JSON.stringify(proof));
  return proof;
}
function mutate(source, from, to, method) {
  if (!method) {
    if (source.split(from).length !== 2) throw new Error(`Expected one mutation site: ${from}`);
    return source.replace(from, to);
  }
  const sf = ts.createSourceFile("owner.ts", source, ts.ScriptTarget.Latest, true);
  const owner = sf.statements.find(ts.isClassDeclaration);
  const node = owner.members.find(node => node.name?.getText(sf) === method);
  const body = node.getText(sf);
  if (body.split(from).length !== 2) throw new Error(`Expected one mutation site in ${method}`);
  return source.slice(0, node.getStart(sf)) + body.replace(from, to) + source.slice(node.end);
}
const results = [];
const original = process.argv.includes("--baseline");
try {
  if (original) {
    writeFileSync(core + files[0], execFileSync("git", ["show", `${baseline}:${core + files[0]}`]));
    results.push(run("original-observable", true));
  } else {
    for (const [name, file, from, to, pattern, method] of mutations) {
      writeFileSync(core + file, mutate(originals.get(file), from, to, method));
      try { results.push(run(name, false, pattern)); }
      finally { writeFileSync(core + file, originals.get(file)); }
    }
  }
} finally {
  for (const [file, source] of originals) writeFileSync(core + file, source);
  if (protectedPaths.some((file, index) => hash(file) !== protectedBefore[index])) throw new Error("Protected fixture changed");
  writeFileSync(`${directory}/${original ? "baseline" : "mutation"}-summary.json`, JSON.stringify({ baseline, results, protectedBefore }, null, 2) + "\n");
}
