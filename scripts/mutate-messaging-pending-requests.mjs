import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const baseline = "d4e7a215b4edaeeb9847ab8d673693612dbee107";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const directory = ".local/pwr-149-pending-requests/mutations";
mkdirSync(directory, { recursive: true });
const files = ["messaging-controller.ts", "messaging-pending-request-workflow.ts", "messaging-pending-request-context.ts", "messaging-pending-request-helpers.ts"];
const originals = new Map(files.map(file => [file, readFileSync(core + file, "utf8")]));
const protectedPaths = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(file => `${tests}fixtures/${file}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedBefore = protectedPaths.map(hash);
// Optional method names restrict a mutation to one actual production body.
const mutations = [
  [
    "constructor-reads-host",
    "messaging-pending-request-workflow.ts",
    "constructor(private readonly context: MessagingPendingRequestContext) {}",
    "constructor(private readonly context: MessagingPendingRequestContext) { void context.host; }",
    "constructs without reading"
  ],
  [
    "facade-captures-store",
    "messaging-controller.ts",
    "this.pendingRequests = new MessagingPendingRequestWorkflow({\n      get store() { return readStore(); },",
    "this.pendingRequests = new MessagingPendingRequestWorkflow({\n      store: readStore(),",
    "coalesces overlapping"
  ],
  [
    "clock-receiver-lost",
    "messaging-controller.ts",
    "this.pendingRequests = new MessagingPendingRequestWorkflow({\n      get store() { return readStore(); },\n      get backend() { return readBackend(); },\n      get capabilityProfile() { return readCapabilityProfile(); },\n      now: () => this.now(),",
    "this.pendingRequests = new MessagingPendingRequestWorkflow({\n      get store() { return readStore(); },\n      get backend() { return readBackend(); },\n      get capabilityProfile() { return readCapabilityProfile(); },\n      get now() { return readNow(); },",
    "preserves clock receivers"
  ],
  [
    "public-caller-dropped",
    "messaging-controller.ts",
    "await this.pendingRequests.handleBackendPendingRequest(backend, request, federationTarget);",
    "return;",
    "routes the public pending-request"
  ],
  [
    "resolution-caller-dropped",
    "messaging-controller.ts",
    "handleBackendRequestResolved: (...args) => this.pendingRequests.handleBackendRequestResolved(...args)",
    "handleBackendRequestResolved: async () => {}",
    "retires externally resolved",
    "backendEventHost"
  ],
  [
    "host-commits-wrong-status",
    "messaging-controller.ts",
    "this.setActiveTurn(...args)",
    "this.setActiveTurn(args[0], { ...args[1], status: \"completed\" })",
    "keeps approvals actionable",
    "pendingRequestHost"
  ],
  [
    "duplicate-reservations",
    "messaging-pending-request-workflow.ts",
    "if (existing)",
    "if (false)",
    "coalesces overlapping",
    "handleBackendPendingRequest"
  ],
  [
    "reservation-cleanup-lost",
    "messaging-pending-request-workflow.ts",
    "this.pendingRequestPresentations.delete(key);",
    "void key;",
    "coalesces overlapping",
    "handleBackendPendingRequest"
  ],
  [
    "reservation-owner-scope-lost",
    "messaging-pending-request-workflow.ts",
    "federationTarget?.scope === \"remote\" ? federationTarget.instanceId : undefined",
    "undefined",
    "keeps presentation reservations",
    "handleBackendPendingRequest"
  ],
  [
    "back-moves-forward",
    "messaging-pending-request-workflow.ts",
    "currentIndex: intent.currentIndex - 1",
    "currentIndex: intent.currentIndex + 1",
    "matches an independent answer",
    "questionnaireWithPreviousQuestion"
  ],
  [
    "answer-does-not-advance",
    "messaging-pending-request-workflow.ts",
    "currentIndex: nextIndex",
    "currentIndex: intent.currentIndex",
    "matches an independent answer",
    "questionnaireWithRecordedAnswer"
  ],
  [
    "never-submits-complete-answers",
    "messaging-pending-request-workflow.ts",
    "return (",
    "return false && (",
    "matches an independent answer",
    "questionnaireReadyToSubmit"
  ],
  [
    "retires-before-acceptance",
    "messaging-pending-request-workflow.ts",
    "await this.submitQuestionnaireIntent(submittedIntent);",
    "await this.context.store.deletePendingIntent(pendingIntent.id);\n    await this.submitQuestionnaireIntent(submittedIntent);",
    "preserves the pending form",
    "submitAndRetireQuestionnaire"
  ],
  [
    "returned-surface-lost",
    "messaging-pending-request-workflow.ts",
    "surface: result.surface ?? pendingIntent.surface",
    "surface: pendingIntent.surface",
    "persists an answer update",
    "updateQuestionnairePendingIntent"
  ],
  [
    "persists-before-delivery",
    "messaging-pending-request-workflow.ts",
    "const result = await this.deliverQuestionnaireIntent(pendingIntent, intent, event);",
    "await this.context.store.upsertPendingIntent({ ...pendingIntent, intent });\n    const result = await this.deliverQuestionnaireIntent(pendingIntent, intent, event);",
    "persists an answer update",
    "updateQuestionnairePendingIntent"
  ],
  [
    "async-card-not-claimed-before-echo",
    "messaging-pending-request-workflow.ts",
    "await this.context.store.deletePendingIntent(pendingIntent.id);\n    const sent =",
    "const sent =",
    "routes async replies",
    "submitAsyncQuestionnaire"
  ],
  [
    "refused-async-card-not-restored",
    "messaging-pending-request-workflow.ts",
    "if (!sent)",
    "if (false)",
    "routes async replies",
    "submitAsyncQuestionnaire"
  ],
  [
    "invisible-async-card-not-cleaned",
    "messaging-pending-request-workflow.ts",
    "if (delivery.outcome === \"failed\")",
    "if (false)",
    "retires async cards",
    "deliverAsyncQuestionnaire"
  ],
  [
    "external-answer-owner-not-checked",
    "messaging-pending-request-workflow.ts",
    "if (binding && !bindingMatchesFederationTarget(binding, event.federationTarget))",
    "if (false)",
    "retires async cards",
    "retireAnsweredAsyncQuestionnaires"
  ],
  [
    "approval-retirement-posts-fallback",
    "messaging-pending-request-workflow.ts",
    "fallback: \"fail\"",
    "fallback: \"present_new\"",
    "keeps approvals actionable",
    "retireApprovalIntent"
  ],
  [
    "answer-encoding-caller-dropped",
    "messaging-pending-request-workflow.ts",
    "questionnaireAnswerValue(intent.answers[index])",
    "[]",
    "matches an independent answer",
    "submitQuestionnaireIntent"
  ],
  [
    "answer-whitespace-not-normalized",
    "messaging-pending-request-helpers.ts",
    "answer?.value.trim()",
    "answer?.value",
    "encodes one full nonblank"
  ],
  [
    "optional-getter-read-dropped",
    "messaging-pending-request-workflow.ts",
    "!requestContext || !this.context.backend.submitServerRequest",
    "!requestContext || false",
    "keeps optional submission getters",
    "submitQuestionnaireIntent"
  ],
  [
    "admission-getter-moved-outside-catch",
    "messaging-pending-request-workflow.ts",
    "let admissionState: MessagingThreadAdmissionState;",
    "void this.context.backend.getThreadAdmissionState;\n    let admissionState: MessagingThreadAdmissionState;",
    "keeps the admission getter",
    "sendAsyncQuestionReply"
  ],
  [
    "permission-host-refuses-allowed-reply",
    "messaging-controller.ts",
    "requirePermission: (...args) => this.accessControl.requirePermission(...args)",
    "requirePermission: async () => false",
    "routes async replies",
    "pendingRequestHost"
  ],
  [
    "resolved-record-not-deleted",
    "messaging-pending-request-workflow.ts",
    "await this.context.store.deletePendingIntent(pendingIntent.id);",
    "// mutation: leave the pending record",
    "retires externally resolved",
    "handleBackendRequestResolved"
  ]
];

function run(name, shouldPass, pattern) {
  const log = `${directory}/${name}.log`;
  const report = resolve(`${directory}/${name}.json`);
  const fd = openSync(log, "w");
  const paths = ["messaging-pending-request-observable.property.test.ts", ...(shouldPass ? [] : ["messaging-pending-request-workflow.test.ts", "messaging-pending-request-helpers.property.test.ts"])];
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
