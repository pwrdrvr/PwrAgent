import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const baseline = "b54346c56247fef9e6ee8c925aad5ea37a37595c";
const retentionBaseline = "3a22f787cb0d92b21965f35a24048f9d888f1c05";
const directory = ".local/pwr-149-private/mutations";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const controller = `${core}messaging-controller.ts`;
const router = `${core}messaging-backend-event-router.ts`;
const context = `${core}messaging-backend-event-context.ts`;
const state = `${core}messaging-private-response-state.ts`;
const claims = `${core}messaging-private-reply-claims.ts`;
const files = [controller, router, context, state, claims];
const originals = new Map(files.map(file => [file, readFileSync(file, "utf8")]));
const protectedFiles = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(name => `${tests}fixtures/${name}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = protectedFiles.map(hash);
mkdirSync(directory, { recursive: true });
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
function restore() {
  for (const [file, source] of originals) writeFileSync(file, source);
  for (const [index, file] of protectedFiles.entries()) if (hash(file) !== hashes[index]) throw new Error(`Protected fixture changed: ${file}`);
}
function mutate(file, before, after) {
  const source = originals.get(file);
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Non-unique mutation anchor: ${before}`);
  writeFileSync(file, source.replace(before, after));
}
function run(name, selected, expected, pattern) {
  const result = spawnSync("pnpm", ["test", ...selected.map(file => `${tests}${file}`), ...(pattern ? ["-t", pattern] : [])], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(`${directory}/${name}.log`, log);
  const invalid = /SyntaxError|ReferenceError|Failed to load|Cannot find module|Cannot read properties|is not a function|invalid signature|timed out/.test(log);
  const assertions = /AssertionError|expected .* to |Property failed after/.test(log);
  const passed = expected === "pass" ? result.status === 0 : result.status !== 0 && assertions && !invalid;
  return { name, status: result.status, assertions, invalid, passed };
}
const stateTests = ["messaging-private-response-state.property.test.ts"];
const observable = ["messaging-private-response-observable.property.test.ts"];
const mutations = [
  ["settlement-recency", state, 'if (result.effects.includes("retainHistory")) this.entries.delete(key);', 'false && this.entries.delete(key);', ["messaging-private-response-history.property.test.ts", "messaging-private-response-eviction.property.test.ts"]],
  ["terminal-replay-recency", state, 'effects: state.lifetime === "live" && state.pending === 0 ? ["retainHistory"] : [],', 'effects: state.pending === 0 ? ["retainHistory"] : [],', ["messaging-private-response-history.property.test.ts"]],
  ["fallback-reclaim", state, 'state.status === "fallbackHeld"\n        ? { state:', '(state.status === "fallbackHeld" || state.status === "fallbackAttempted")\n        ? { state:', stateTests],
  ["terminal-downgrade", state, '...withPhase(base, state?.status === "terminal" ?', '...withPhase(base, false ?', stateTests],
  ["live-eviction", state, 'return state.lifetime === "settled" && state.pending === 0', 'return state.pending === 0', stateTests],
  ["pending-eviction", state, 'return state.lifetime === "settled" && state.pending === 0', 'return state.lifetime === "settled"', stateTests],
  ["history-cap", state, 'PRIVATE_RESPONSE_HISTORY_LIMIT = 1_000', 'PRIVATE_RESPONSE_HISTORY_LIMIT = 999', stateTests],
  ["text-cap", state, 'PRIVATE_RESPONSE_TEXT_LIMIT = 256', 'PRIVATE_RESPONSE_TEXT_LIMIT = 255', stateTests],
  ["receipt-identity", state, 'this.entries.get(receipt.key)?.generation === receipt.generation', 'this.entries.has(receipt.key)', stateTests],
  ["reply-live-eviction", claims, 'case "evict": return state === "completed" ? undefined : state;', 'case "evict": return undefined;', ["messaging-private-reply-claims.property.test.ts"]],
  ["reply-release", claims, 'case "release": return state === "claimed" ? undefined : state;', 'case "release": return state;', ["messaging-private-reply-claims.property.test.ts"]],
  ["delivered-caller", controller, 'this.privateResponses.delivered(privateReceipt);', 'void privateReceipt;', observable],
  ["delivery-order", controller, 'const privateReceipt = this.privateResponses.beginTool(turnKey);', 'const privateReceipt = this.privateResponses.beginTool(turnKey);\n    this.privateResponses.delivered(privateReceipt);', observable],
  ["settlement-caller", controller, 'this.privateResponses.finishTool(privateReceipt);', 'void privateReceipt;', ["messaging-private-response-routing.test.ts"]],
  ["admission-caller", controller, 'fallback: Boolean(origin.privateResponseRequested || requestsExplicitPrivateResponse(origin.event)),\n    });', 'fallback: false,\n    });', observable],
  ["fallback-host-port", controller, 'get privateResponses() { return readController().privateResponses; },', 'get privateResponses() { return { hold: () => undefined, heldText: () => undefined, completeReply: () => undefined }; },', ["messaging-private-response-routing.test.ts"]],
  ["router-hold", router, 'this.context.host().privateResponses.hold(', 'false && this.context.host().privateResponses.hold(', ["messaging-private-response-routing.test.ts"]],
];
const results = [];
try {
  if (process.argv.includes("--retention-baseline")) {
    writeFileSync(state, execFileSync("git", ["show", `${retentionBaseline}:${state}`], { encoding: "utf8" }));
    results.push(run("retention-pre-fix-model", ["messaging-private-response-history.property.test.ts"], "assertion"));
    results.push(run("retention-pre-fix-router", ["messaging-private-response-eviction.property.test.ts"], "assertion", "late private"));
  } else if (process.argv.includes("--baseline")) {
    for (const file of [controller, router, context]) writeFileSync(file, execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
    results.push(run("baseline-sequential-oracle", observable, "pass", "preserves explicit-tool"));
    results.push(run("baseline-inflight-counterexample", observable, "assertion", "withholds source text"));
    results.push(run("baseline-eviction-counterexample", ["messaging-private-response-eviction.property.test.ts"], "assertion"));
  } else {
    for (const [name, file, before, after, selected] of mutations) {
      if (only && !name.includes(only)) continue;
      mutate(file, before, after);
      try {
        const result = run(name, selected, "assertion");
        results.push(result);
        console.log(JSON.stringify(result));
      } finally { restore(); }
    }
  }
} finally {
  restore();
  const suffix = process.argv.includes("--retention-baseline") ? "-retention-baseline" : process.argv.includes("--baseline") ? "-baseline" : "";
  writeFileSync(`${directory}/results${suffix}.json`, `${JSON.stringify(results, null, 2)}\n`);
}
console.log(JSON.stringify({ baseline: process.argv.includes("--retention-baseline") ? retentionBaseline : baseline, attempted: results.length, detected: results.filter(result => result.passed).length, protectedFixturesUnchanged: true }));
if (!results.length || results.some(result => !result.passed)) process.exitCode = 1;
