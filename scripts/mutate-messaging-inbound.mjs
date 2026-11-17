import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const baseline = "c7219ed95c1d7f70f10fd6648eb65e7317857cfc";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const controller = `${core}messaging-controller.ts`;
const owner = `${core}messaging-inbound-turns.ts`;
const helpers = `${core}messaging-inbound-helpers.ts`;
const originals = new Map([controller, owner, helpers].map(file => [file, readFileSync(file, "utf8")]));
const directory = ".local/pwr-149-inbound/mutations";
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(name => `${tests}fixtures/${name}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = protectedFiles.map(hash);
mkdirSync(directory, { recursive: true });
const ownerTest = "messaging-inbound-turns.property.test.ts";
const observable = "messaging-inbound-observable.property.test.ts";
const pure = "messaging-inbound-helpers.property.test.ts";
const constructor = "constructor(private readonly context: MessagingInboundContext) {}";
const sections = {
  text: ["  async handleText(", "  async bootstrapDefaultAgentForAcceptedMessage("],
  construction: ["    this.inboundTurns = new MessagingInboundTurns({", "    this.authorizedActorIds ="],
  host: ["  private inboundHost():", "  private commandHost():"],
};
// A test selector avoids unrelated held operations when a mutation deliberately
// omits the caller that would reach their gate. Missing-owner errors, import
// failures and timeouts never count as evidence.
const mutations = [
  ["metadata-await-order", owner, [["await this.context.host().bindingService.refreshBindingFromInbound(event);", "void this.context.host().bindingService.refreshBindingFromInbound(event);"]], ownerTest, "awaits binding enrichment"],
  ["permission-gate", owner, [["await this.context.host().requirePermission(", "await (async () => true)("]], ownerTest, "stops before admission", "text"],
  ["remote-owner-gate", owner, [["await this.context.host().requireRemoteScopeForBinding(", "await (async () => true)("]], ownerTest, "stops before admission", "text"],
  ["mention-policy", owner, [['return responseMode === "every_message" || event.botMention === true;', "return true;"]], observable, "applies provider mention"],
  ["full-access-resume", owner, [["const allowed = controls.allowThreadResume;", "const allowed = true;"]], observable, "applies provider mention"],
  ["acceptance-boundary", owner, [["let turnStarted = false;", "let turnStarted = true;"]], observable, "preserves acceptance through terminal sessions"],
  ["private-claim-retry", owner, [["if (replyClaim) this.context.host().privateReplyClaims.release(replyClaim);", "if (replyClaim) this.context.host().privateReplyClaims.complete(replyClaim);"]], ownerTest, "releases a failed private-reply claim"],
  ["attachment-order", owner, [["for (const turnEvent of events) {", "for (const turnEvent of [...events].reverse()) {"]], ownerTest, "prepares attachments in event order"],
  ["adapter-receiver", owner, [["adapter: this.context.adapter,", "adapter: { ...this.context.adapter },"]], ownerTest, "preserves the native download receiver"],
  ["pdf-getter-boundary", owner, [["!this.context.backend.supportsMessagingPdfTools\n", "!(() => { try { return this.context.backend.supportsMessagingPdfTools; } catch { return undefined; } })()\n"]], ownerTest, "optional PDF support getter"],
  ["first-mark", owner, [["timing.marks[stage] ??= this.context.now();", "timing.marks[stage] = this.context.now();"]], ownerTest, "keeps timing marks bounded"],
  ["timing-cardinality", helpers, [["export const ADMISSION_STAGE_MARK_LIMIT = 256;", "export const ADMISSION_STAGE_MARK_LIMIT = 257;"]], ownerTest, "keeps timing marks bounded"],
  ["prompt-cleanup-caller", controller, [["    this.inboundTurns.clearPendingPrompts();", ""]], ownerTest, "cancels its timer during facade shutdown"],
  ["timing-cleanup-caller", controller, [["    this.inboundTurns.clearAdmissionTiming();", ""]], ownerTest, "cancels its timer during facade shutdown"],
  ["store-snapshot", owner, [[constructor, 'constructor(private readonly context: MessagingInboundContext) { const store = context.store; this.context = new Proxy(context, { get: (target, key) => key === "store" ? store : Reflect.get(target, key, target) }); }']], ownerTest, "does not read a collaborator"],
  ["host-snapshot", owner, [[constructor, 'constructor(private readonly context: MessagingInboundContext) { const host = context.host(); this.context = new Proxy(context, { get: (target, key) => key === "host" ? () => host : Reflect.get(target, key, target) }); }']], ownerTest, "resolves a replaced host"],
  ["overlay-port", controller, [["      get store() { return readStore(); },", "      store: readStore(),"]], observable, "reads the replacement overlay", "construction"],
  ["configuration-receiver-port", controller, [["      get config() { return readInboundConfig(); },", "      get config() { return { ...readInboundConfig() }; },"]], ownerTest, "retains native configuration callbacks", "construction"],
  ["clock-receiver-port", controller, [["      now: () => this.now(),", "      get now() { return readNow(); },"]], ownerTest, "retains native configuration callbacks", "construction"],
  ["facade-text-caller", controller, [["      await this.inboundTurns.handleText(event);", "      return;"]], observable, "preserves acceptance through terminal sessions"],
  ["delivery-port", controller, [["      deliver: (...args) => this.deliver(...args),", '      deliver: async () => ({ outcome: "presented", channel: "telegram", deliveredAt: 0 }),']], observable, "pending new-thread prompt recoverable", "host"],
  ["private-request-negation", helpers, [["return !NEGATED_PRIVATE_RESPONSE_PREFIX_PATTERN.test(", "return true || !NEGATED_PRIVATE_RESPONSE_PREFIX_PATTERN.test("]], pure, "requires affirmative private delivery"],
];
function changedSource(name, file, edits, section) {
  const source = originals.get(file);
  const range = sections[section];
  const start = range ? source.indexOf(range[0]) : 0;
  const end = range ? source.indexOf(range[1], start) : source.length;
  if (start < 0 || end < 0) throw new Error(`Missing mutation section: ${name}`);
  let text = source.slice(start, end);
  for (const [before, after] of edits) {
    if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Non-unique mutation anchor: ${name}`);
    text = text.replace(before, after);
  }
  return source.slice(0, start) + text + source.slice(end);
}
function restore() {
  for (const [file, text] of originals) writeFileSync(file, text);
  for (const [index, file] of protectedFiles.entries()) if (hash(file) !== hashes[index]) throw new Error(`Protected fixture changed: ${file}`);
}
function run(name, selected, expectPass, testName) {
  const result = spawnSync("pnpm", ["test", ...selected.map(file => tests + file), ...(testName ? ["-t", testName] : [])], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(`${directory}/${name}.log`, log);
  const assertions = /AssertionError/.test(log);
  const invalid = /TypeError|SyntaxError|ReferenceError|Failed to load|Cannot find module|Cannot read properties|is not a function|invalid signature|timed out|No test files found/.test(log);
  const passed = expectPass ? result.status === 0 : result.status !== 0 && assertions && !invalid;
  const evidence = { name, status: result.status, assertions, invalid, passed };
  console.log(JSON.stringify(evidence));
  return evidence;
}
if (process.argv.includes("--check")) {
  for (const [name, file, edits, , , section] of mutations) changedSource(name, file, edits, section);
  console.log(JSON.stringify({ anchorsVerified: mutations.length }));
  process.exit(0);
}
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const results = [];
try {
  if (process.argv.includes("--baseline")) {
    writeFileSync(controller, execFileSync("git", ["show", `${baseline}:${controller}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
    results.push(run("pinned-main-observable", [observable], true));
  } else {
    results.push(run("extracted-production", [ownerTest, observable, pure], true));
    for (const [name, file, edits, selected, testName, section] of mutations) {
      if (only && !name.includes(only)) continue;
      writeFileSync(file, changedSource(name, file, edits, section));
      try { results.push(run(name, [selected], false, testName)); } finally { restore(); }
    }
  }
} finally { restore(); }
const suffix = process.argv.includes("--baseline") ? "-baseline" : only ? `-only-${only.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
writeFileSync(`${directory}/results${suffix}.json`, `${JSON.stringify(results, null, 2)}\n`);
if (results.some(result => !result.passed)) process.exitCode = 1;
