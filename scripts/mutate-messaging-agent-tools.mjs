import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const baseline = "d25d77e2052f19a090c77eabbf28041f8984abd5";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const directory = ".local/pwr-149-agent-tools/mutations";
mkdirSync(directory, { recursive: true });
const files = ["messaging-controller.ts", "messaging-agent-tools.ts", "messaging-agent-tool-context.ts", "messaging-agent-tool-helpers.ts"];
const originals = new Map(files.map(file => [file, readFileSync(core + file, "utf8")]));
const protectedPaths = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(file => `${tests}fixtures/${file}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedBefore = protectedPaths.map(hash);
// Optional method names restrict a mutation to one actual production body.
const mutations = [
  ["rename-before-acknowledgement", files[1], "    const result = await this.context.adapter.setConversationTitle({", "    if (origin.origin.binding) await this.context.store.upsertBinding({ ...origin.origin.binding, channel: { ...origin.origin.binding.channel, conversation: { ...origin.origin.binding.channel.conversation, title } } });\n    const result = await this.context.adapter.setConversationTitle({", "commits renamed bindings"],
  ["failed-rename-accepted", files[1], "if (result.outcome !== \"updated\")", "if (false)", "commits renamed bindings"],
  ["rename-receiver-lost", files[1], "this.context.adapter.setConversationTitle({", "(0, this.context.adapter.setConversationTitle)({", "commits renamed bindings"],
  ["upload-byte-cap-ignored", files[1], "resolveMessagingOutboundBytes(fileRequest, this.context.capabilityProfile.outboundAttachments ?? {}, receivedFile)", "resolveMessagingOutboundBytes(fileRequest, { ...this.context.capabilityProfile.outboundAttachments, maxUploadBytes: Infinity }, receivedFile)", "applies provider upload"],
  ["upload-support-forced", files[1], "resolveMessagingOutboundBytes(fileRequest, this.context.capabilityProfile.outboundAttachments ?? {}, receivedFile)", "resolveMessagingOutboundBytes(fileRequest, { ...this.context.capabilityProfile.outboundAttachments, supportsFileUpload: true }, receivedFile)", "applies provider upload"],
  ["failed-file-accepted", files[1], "if (!isVisibleAssistantStreamDelivery(result))", "if (false)", "keeps source final prose", "sendMessagingFileFromAgentMessagingOrigin"],
  ["file-suppresses-source", files[1], "    this.recordOutboundFileActivity({", "    const receipt = this.context.privateResponses.beginTool(agentMessagingTurnKey(request.context.backend, request.context.threadId, request.context.turnId ?? \"\"));\n    this.context.privateResponses.delivered(receipt);\n    this.context.privateResponses.finishTool(receipt);\n    this.recordOutboundFileActivity({", "keeps source final prose"],
  ["private-success-not-recorded", files[1], "this.context.privateResponses.delivered(privateReceipt);", "// mutation: lose private delivery", "preserves explicit-tool"],
  ["private-finally-leaks-receipt", files[1], "this.context.privateResponses.finishTool(privateReceipt);", "// mutation: leak receipt", "preserves the separate private resolver"],
  ["stale-revision-admitted", files[1], "if (request.args.expectedRevision && request.args.expectedRevision !== selected.ref.requestId)", "if (false)", "reuses retained attachment"],
  ["attachment-claim-repeated", files[1], "if (!claim.claimed)", "if (false)", "reuses retained attachment"],
  ["remote-owner-gate-bypassed", files[1], "if (!await this.context.host().requireRemoteScope(origin.origin.event, target.federatedThread?.target, \"agent-attach:remote-instance\", { notify: false }))", "if (false)", "checks resolved remote-owner"],
  ["target-getter-outside-catch", files[1], "    let target: NavigationThreadSummary | undefined;", "    void this.context.backend.resolveThreadTarget;\n    let target: NavigationThreadSummary | undefined;", "keeps optional backend getters"],
  ["constructor-reads-host", files[1], "constructor(private readonly context: MessagingAgentToolContext) {}", "constructor(private readonly context: MessagingAgentToolContext) { void context.host; }", "constructs and validates"],
  ["facade-captures-store", files[0], "this.agentToolWorkflow = new MessagingAgentTools({\n      get store() { return readStore(); },", "this.agentToolWorkflow = new MessagingAgentTools({\n      store: readStore(),", "uses the replacement wrapped store"],
  ["clock-receiver-lost", files[0], "get config() { return readAgentToolConfig(); },\n      now: () => this.now(),", "get config() { return readAgentToolConfig(); },\n      get now() { return readNow(); },", "uses the replacement wrapped store"],
  ["facade-caller-drops-operation", files[0], "return await this.agentToolWorkflow.handlePwrAgentMessagingRequest(request, receivedFile, consumeOriginal);", "return { ok: false, error: { code: \"not_found\", message: \"Mutation dropped request\" } };", "keeps source final prose"],
  ["reply-snapshot-shares-channel", files[3], "channel: structuredClone(binding.channel),", "channel: binding.channel,", "keeps private-reply routing"],
  ["pdf-zero-page-accepted", files[3], "Number.isSafeInteger(value) && value > 0", "Number.isSafeInteger(value) && value >= 0", "accepts only nonempty PDF"],
  ["child-title-cap-exceeded", files[3], ".slice(0, 100)", ".slice(0, 101)", "bounds child titles"],
];
function run(name, shouldPass, pattern) {
  const log = `${directory}/${name}.log`;
  const report = resolve(`${directory}/${name}.json`);
  const fd = openSync(log, "w");
  const paths = ["messaging-agent-tools-observable.property.test.ts", "messaging-private-response-observable.property.test.ts", "messaging-access-observable.property.test.ts", "contained-messaging.property.test.ts",
    ...(shouldPass ? [] : ["messaging-agent-tools.test.ts", "messaging-agent-tool-helpers.property.test.ts"])];
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
