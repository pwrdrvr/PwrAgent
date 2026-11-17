import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const baseline = "9e8826a71db9f97c1cb1edf6a033d22872cb753a";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const controller = `${core}messaging-controller.ts`;
const service = `${core}messaging-binding-service.ts`;
const helpers = `${core}messaging-binding-helpers.ts`;
const observableFile = `${tests}messaging-binding-observable.property.test.ts`;
const originals = new Map([controller, service, helpers, observableFile].map(file => [file, readFileSync(file, "utf8")]));
const directory = ".local/pwr-149-binding/mutations";
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(name => `${tests}fixtures/${name}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = protectedFiles.map(hash);
mkdirSync(directory, { recursive: true });
const owner = ["messaging-binding-service.property.test.ts"];
const observable = ["messaging-binding-observable.property.test.ts"];
const pure = ["messaging-binding-helpers.property.test.ts"];
const constructor = "constructor(private readonly context: MessagingBindingContext) {}";
const retirement = '    await this.retireBindingStatus(\n      binding,\n      event,\n      { kind: "thread", thread: await this.context.host().readBoundNavigationThread(binding) },\n    );';
const revoke = "    await this.context.store.revokeBinding({\n      bindingId: binding.id,\n      revokedAt: this.context.now(),\n    });";
const mutations = [
  ["detach-notification-order", service, [[revoke, '    this.notifyBindingChanged("detach");\n' + revoke], ['    this.notifyBindingChanged("detach");\n    if (options.deliverConfirmation', '    if (options.deliverConfirmation']], observable, "pipeline"],
  ["detach-retirement-order", service, [[retirement, revoke + "\n" + retirement], ["\n\n" + revoke, ""]], observable, "pipeline"],
  ["provider-scope", service, [["if (!this.context.host().isChannelInScope(binding.channel))", "if (false && !this.context.host().isChannelInScope(binding.channel))"]], observable],
  ["remote-bind-backstop", service, [["!(await this.context.host().requireRemoteScope(", "false && !(await this.context.host().requireRemoteScope("]], owner],
  ["cleanup-boundary", service, [['      this.context.logger.debug?.(\n        "messaging channel pending-intent cleanup failed on bind",', '      throw error;\n      this.context.logger.debug?.(\n        "messaging channel pending-intent cleanup failed on bind",']], observable],
  ["audit-getter-boundary", service, [["if (this.context.backend.recordMessagingBindingTransition) {", "if ((() => { try { return this.context.backend.recordMessagingBindingTransition; } catch { return undefined; } })()) {"]], owner],
  ["status-lock", service, [["return await this.statusRenderLock.run(binding.id, async () => {", "return await (async () => {"], ["    });", "    })();"]], owner, "render"],
  ["post-revoke-write", service, [["if (latestBinding?.revokedAt)", "if (false && latestBinding?.revokedAt)"]], observable, "renderUnlocked"],
  ["store-snapshot", service, [[constructor, 'constructor(private readonly context: MessagingBindingContext) { const store = context.store; this.context = new Proxy(context, { get: (target, key) => key === "store" ? store : Reflect.get(target, key, target) }); }']], owner],
  ["host-snapshot", service, [[constructor, 'constructor(private readonly context: MessagingBindingContext) { const host = context.host(); this.context = new Proxy(context, { get: (target, key) => key === "host" ? () => host : Reflect.get(target, key, target) }); }']], owner],
  ["adapter-receiver", service, [["await this.context.adapter.setConversationTitle({", "await (0, this.context.adapter.setConversationTitle)({"]], owner],
  ["title-whitespace", helpers, [['title?.replace(/\\s+/g, " ").trim()', "title?.trim()"]], pure],
  ["handoff-observed-branch", helpers, [["    thread.observedGitBranch ??\n    thread.gitBranch ??", "    thread.gitBranch ??\n    thread.observedGitBranch ??"]], pure],
  ["facade-caller", controller, [["return await this.bindingService.handleBindingRevokeRequest(binding);", "return true;"]], observable],
  ["delivery-port", controller, [["      deliver: (...args) => this.deliver(...args),", '      deliver: async () => ({ outcome: "presented", channel: "telegram", deliveredAt: 0 }),']], owner, "bindingHost"],
  ["overlay-port", controller, [["      get store() { return readStore(); },", "      store: readStore(),"]], observable, "construction"],
  ["shutdown-adapter-port", controller, [["      get adapter() { return readAdapter(); },", "      adapter: readAdapter(),"]], observable, "construction"],
  ["configuration-receiver-port", controller, [["      get config() { return readBindingConfig(); },", "      get config() { return { ...readBindingConfig() }; },"]], observable, "construction"],
  ["clock-receiver-port", controller, [["      now: () => this.now(),", "      get now() { return readNow(); },"]], observable, "construction"],
];
const sections = {
  pipeline: ["  private async runDetachPipeline(", "  async handleBindingRevokeRequest("],
  render: ["  async renderBindingStatus(", "  private async renderBindingStatusUnlocked("],
  renderUnlocked: ["  private async renderBindingStatusUnlocked(", "  async renderAutomaticBindingStatus("],
  bindingHost: ["  private bindingHost():", "  private callbackHost():"],
  construction: ["    this.bindingService = new MessagingBindingService({", "    this.authorizedActorIds ="],
};
function restore() {
  for (const [file, text] of originals) writeFileSync(file, text);
  for (const [index, file] of protectedFiles.entries()) if (hash(file) !== hashes[index]) throw new Error(`Protected fixture changed: ${file}`);
}
function run(name, selected, expectPass, extra = []) {
  const result = spawnSync("pnpm", ["test", ...selected.map(file => tests + file), ...extra], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(`${directory}/${name}.log`, log);
  const assertions = /AssertionError/.test(log);
  const invalid = /SyntaxError|ReferenceError|Failed to load|Cannot find module|Cannot read properties|is not a function|invalid signature|timed out/.test(log);
  const passed = expectPass ? result.status === 0 : result.status !== 0 && assertions && !invalid;
  const evidence = { name, status: result.status, assertions, invalid, passed };
  console.log(JSON.stringify(evidence));
  return evidence;
}
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
if (process.argv.includes("--check")) {
  for (const [name, file, edits, , section] of mutations) changedSource(name, file, edits, section);
  console.log(JSON.stringify({ anchorsVerified: mutations.length }));
  process.exit(0);
}
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const counterexample = process.argv.includes("--retirement-counterexample");
const results = [];
try {
  if (counterexample) {
    // This is a known-bad production protocol, separate from the intended
    // oracle. It changes only the held delivery boundary, never production.
    for (const version of ["original", "extracted"]) {
      if (version === "original") writeFileSync(controller, execFileSync("git", ["show", `${baseline}:${controller}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
      const anchor = '!intent.id.startsWith("status:") || held';
      writeFileSync(observableFile, originals.get(observableFile).replace(anchor, '!intent.id.startsWith("status-retire:") || held'));
      results.push(run(`retirement-${version}`, observable, false, ["-t", "never revives a revoked binding"]));
      restore();
    }
  } else if (process.argv.includes("--baseline")) {
    writeFileSync(controller, execFileSync("git", ["show", `${baseline}:${controller}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
    results.push(run("pinned-main-observable", observable, true));
  } else {
    results.push(run("extracted-production", [...owner, ...observable, ...pure], true));
    for (const [name, file, edits, selected, section] of mutations) {
      if (only && !name.includes(only)) continue;
      writeFileSync(file, changedSource(name, file, edits, section));
      try { results.push(run(name, selected, false)); } finally { restore(); }
    }
  }
} finally { restore(); }
const suffix = counterexample ? "-counterexample" : process.argv.includes("--baseline") ? "-baseline" : "";
writeFileSync(`${directory}/results${suffix}.json`, `${JSON.stringify(results, null, 2)}\n`);
if (results.some(result => !result.passed)) process.exitCode = 1;
