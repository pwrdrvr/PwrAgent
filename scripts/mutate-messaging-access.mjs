import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const baseline = "709b770acae5cc800b78074f41b5180e3219bfa0";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const controller = `${core}messaging-controller.ts`;
const owner = `${core}messaging-access-control.ts`;
const helpers = `${core}messaging-access-helpers.ts`;
const originals = new Map([controller, owner, helpers].map(file => [file, readFileSync(file, "utf8")]));
const directory = ".local/pwr-149-access/mutations";
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(name => `${tests}fixtures/${name}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = protectedFiles.map(hash);
mkdirSync(directory, { recursive: true });
const ownerTest = "messaging-access-control.property.test.ts";
const observable = "messaging-access-observable.property.test.ts";
const pure = "messaging-access-helpers.property.test.ts";
const constructorBody = "this.authorizedActorIds = new Set(actorIds);";
const sections = {
  construction: ["    this.accessControl = new MessagingAccessControl({", "    this.capabilityProfile ="],
  host: ["  private accessHost():", "  async handleInboundEvent("],
};
const mutations = [
  ["legacy-admission", owner, [["return this.isAuthorized(event.actor.platformUserId);", "return true;"]], observable, "re-resolves changed grants"],
  ["named-admission", owner, [["const named = this.authorizedActorIds.has(actorId);", "const named = false;"]], observable, "re-resolves changed grants"],
  ["permission-grant", owner, [["if (resolution.permissions.has(permission)) {", "if (!resolution.permissions.has(permission)) {"]], observable, "re-resolves changed grants"],
  ["silent-floor", owner, [["if (opts?.notify !== false) {", "if (true) {"]], observable, "re-resolves changed grants"],
  ["remote-scope", owner, [["if (!target || target.scope !== \"remote\") {", "if (true) {"]], ownerTest, "adds remote scope only"],
  ["lifecycle-legacy", owner, [["if (params.tool === \"manage_pwragent\") {", "if (false) {"]], observable, "checks tool fields"],
  ["mutation-field-gate", owner, [["? permissionsForThreadMutation(params.arguments)", "? []"]], observable, "checks tool fields"],
  ["remote-tool-gate", owner, [["if (toolArgsTargetRemoteInstance(params.arguments)) {", "if (false) {"]], observable, "requires explicit remote-tool scope"],
  ["turn-attribution", owner, [["agentMessagingTurnKey(params.backend, params.threadId, params.turnId!),", "\"unowned-turn\","]], observable, "attributes a real Default Agent turn"],
  ["retained-approval-mode", owner, [["this.context.adapter.authorizeRetainedSource(source.event, verifyAccess)", "this.context.adapter.authorizeRetainedSource(source.event, true)"]], observable, "verifies retained connection"],
  ["retained-binding-identity", owner, [["binding.threadId !== source.agent.threadId", "false"]], observable, "verifies retained connection"],
  ["effective-default-route", owner, [["assignment.target.threadId !== source.agent.threadId", "false"]], ownerTest, "reads the replaced overlay"],
  ["global-full-access-gate", owner, [["if (!controls.allowEscalation) {", "if (false) {"]], ownerTest, "double-gates Full Access", "escalation"],
  ["warning-dismissal", owner, [["shouldWarn: contact?.fullAccessWarningDismissed !== true,", "shouldWarn: true,"]], ownerTest, "double-gates Full Access"],
  ["warning-effect-order", owner, [["const pending = await this.context.host().storePendingIntent(", "const earlyDelivery = this.context.host().deliver(intent, presentation.binding, event);\n    const pending = await this.context.host().storePendingIntent("], ["const result = await this.context.host().deliver(intent, presentation.binding, event);", "const result = await earlyDelivery;"]], ownerTest, "double-gates Full Access"],
  ["warning-expiry", owner, [["expiresAt: Math.max(context.session.expiresAt, expiresAt),", "expiresAt: context.session.expiresAt,"]], ownerTest, "extends picker warnings"],
  ["audit-getter-boundary", owner, [["try {\n      const log = this.context.host().desktopActivityLog();", "const log = this.context.host().desktopActivityLog();\n    try {"]], ownerTest, "keeps audit failures soft"],
  ["store-snapshot", owner, [[constructorBody, constructorBody + ' const store = context.store; this.context = new Proxy(context, { get: (target, key) => key === "store" ? store : Reflect.get(target, key, target) });']], ownerTest, "reads no live collaborators"],
  ["host-snapshot", owner, [[constructorBody, constructorBody + ' const host = context.host(); this.context = new Proxy(context, { get: (target, key) => key === "host" ? () => host : Reflect.get(target, key, target) });']], ownerTest, "reads no live collaborators"],
  ["overlay-port", controller, [["get store() { return readStore(); },", "store: readStore(),"]], ownerTest, "reads the replaced overlay", "construction"],
  ["configuration-port", controller, [["get config() { return readAccessConfig(); },", "get config() { return { ...readAccessConfig() }; },"]], ownerTest, "uses the facade's native clock", "construction"],
  ["clock-port", controller, [["now: () => this.now(),", "get now() { return readNow(); },"]], ownerTest, "uses the facade's native clock", "construction"],
  ["delivery-port", controller, [["deliver: (...args) => this.deliver(...args),", 'deliver: async () => ({ outcome: "presented", channel: "telegram", deliveredAt: 0 }),']], ownerTest, "uses the facade's native clock", "host"],
  ["facade-admission-caller", controller, [["if (!this.accessControl.authorizeInboundAdmission(event)) {", "if (false) {"]], observable, "re-resolves changed grants"],
  ["facade-tool-caller", controller, [["return this.accessControl.checkDynamicToolPermission(params, source);", "return { owns: false, allowed: true };"]], observable, "checks tool fields"],
  ["default-controls", helpers, [["allowEscalation: resolved?.allowEscalation ?? true,", "allowEscalation: resolved?.allowEscalation ?? false,"]], pure, "defaults absent controls"],
  ["surface-precedence", helpers, [["context.binding?.statusSurface ?? context.binding?.pinnedStatusSurface", "context.binding?.pinnedStatusSurface ?? context.binding?.statusSurface"]], pure, "uses only the selected presentation surface"],
];
sections.escalation = ["  async ensureFullAccessEscalationAllowed(", "  async presentFullAccessRiskWarning("];
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
    results.push(run("pinned-main-observable", [observable, "messaging-inbound-observable.property.test.ts", "contained-messaging.property.test.ts"], true));
  } else {
    results.push(run("extracted-production", [ownerTest, observable, pure, "contained-messaging.property.test.ts"], true));
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
