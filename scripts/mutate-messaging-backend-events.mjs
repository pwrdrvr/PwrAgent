import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const baseline = "f5ce854b255650cba3a22eb6e4b741c0fdc3c53d";
const directory = ".local/pwr-149/mutations";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const facade = `${core}messaging-controller.ts`;
const router = `${core}messaging-backend-event-router.ts`;
const helpers = `${core}messaging-backend-event-helpers.ts`;
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(name => `${tests}fixtures/${name}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedHashes = protectedFiles.map(hash);
const original = new Map([facade, router, helpers].map(file => [file, readFileSync(file, "utf8")]));
mkdirSync(directory, { recursive: true });
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex < 0 ? undefined : process.argv[onlyIndex + 1];
function replace(file, before, after) {
  const source = original.get(file);
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Mutation anchor is not unique: ${before}`);
  writeFileSync(file, source.replace(before, after));
}
function verifyProtected() {
  for (const [index, file] of protectedFiles.entries()) if (hash(file) !== protectedHashes[index]) throw new Error(`Protected fixture changed: ${file}`);
}
function run(name, selectedTests, shouldPass) {
  const result = spawnSync("pnpm", ["test", ...selectedTests.map(file => `${tests}${file}`)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(`${directory}/${name}.log`, log);
  const invalid = /SyntaxError|ReferenceError|Failed to load|Cannot find module|Cannot read properties|is not a function|invalid signature/.test(log);
  const assertions = /AssertionError|expected .* to |Property failed after/.test(log);
  const passed = shouldPass ? result.status === 0 : result.status !== 0 && assertions && !invalid;
  return { name, status: result.status, assertions, invalid, passed };
}
const mutations = [
  ["facade-routing", facade, "return this.backendEventRouter.handleBackendEvent(event);", "return Promise.resolve();"],
  ["host-turn-state", facade, "setActiveTurn: (...args) => this.setActiveTurn(...args),", "setActiveTurn: () => undefined,"],
  ["queue-outcome-await", router, "await this.context.host().applySharedQueueNoticeEvent(key, {", "void this.context.host().applySharedQueueNoticeEvent(key, {"],
  ["queue-origin-effect", router, "await this.context.host().reconcileQueuedAgentMessagingOrigin({", "false && await this.context.host().reconcileQueuedAgentMessagingOrigin({"],
  ["terminal-flush-await", router, "await this.context.host().flushToolUpdatesForBinding(binding, {", "void this.context.host().flushToolUpdatesForBinding(binding, {"],
  ["terminal-card-effect", router, "await this.context.host().finalizeWorkingCard(", "false && await this.context.host().finalizeWorkingCard("],
  ["queue-drain-effect", router, "this.context.host().scheduleNextQueuedTurn(binding);", "void binding;"],
  ["failure-delivery-tracking", router, "pending.add(handling);", "void handling;"],
  ["terminal-interruption", helpers, 'status: params.turn?.status === "interrupted" ? "interrupted" : "completed",', 'status: "completed",'],
];
const results = [];
try {
  if (process.argv.includes("--baseline")) {
    writeFileSync(facade, execFileSync("git", ["show", `${baseline}:${facade}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
    results.push(run("original-main-observable", ["messaging-backend-observable.property.test.ts"], true));
  } else {
    for (const [name, file, before, after] of mutations) {
      if (only && !name.includes(only)) continue;
      replace(file, before, after);
      try {
        const result = run(name, ["messaging-backend-observable.property.test.ts", "messaging-backend-event-router.test.ts", "messaging-backend-event-helpers.test.ts"], false);
        results.push(result);
        console.log(JSON.stringify(result));
      } finally {
        writeFileSync(file, original.get(file));
        verifyProtected();
      }
    }
  }
} finally {
  for (const [file, source] of original) writeFileSync(file, source);
  verifyProtected();
  writeFileSync(`${directory}/results${process.argv.includes("--baseline") ? "-baseline" : ""}.json`, `${JSON.stringify(results, null, 2)}\n`);
}
console.log(JSON.stringify({ baseline, attempted: results.length, passed: results.filter(r => r.passed).length, protectedFixturesUnchanged: true }));
if (results.length === 0 || results.some(r => !r.passed)) process.exitCode = 1;
