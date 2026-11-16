import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// Create a separate worktree at this baseline and install its own dependencies
// first. Run this script from the phase 4 checkout, passing that worktree path.
// Only the two contrived-protocol tests and their gate helper are transplanted;
// the baseline's registry, modules and old-map projection remain unchanged.
const baseline = "93caf4eb0a9f1868c26014fb8dfab281e7592892";
assert.ok(process.argv[2], "Pass a separate baseline worktree path");
const proofRoot = path.resolve(process.argv[2]);
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: proofRoot, encoding: "utf8" }).trim(), baseline);
const file = "apps/desktop/src/main/__tests__/codex-turn-terminal-ordering.property.test.ts";
const current = readFileSync(file, "utf8");
const ast = ts.createSourceFile(file, current, ts.ScriptTarget.Latest, true);
const helpers = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "exerciseTerminalBeforeStartRegistration");
assert.equal(helpers.length, 1);
const cases = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText() === "it" && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.includes("start bookkeeping")) cases.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(cases.length, 2);
const target = path.join(proofRoot, file);
const original = readFileSync(target, "utf8");
assert.ok(original.includes("activeCodexTurnModes"), "The baseline oracle must still read the original activity maps");
const importBefore = 'import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";';
assert.ok(original.includes(importBefore));
// The baseline has no new delivery owner to inspect. Its original assertEnded
// still checks busy, turn keys, modes and collaboration against the old maps.
const helper = helpers[0].getText(ast).replace('    expect(f.activity.codex("thread").deliveries).toEqual([]);\n', "");
assert.ok(!helper.includes("f.activity"), "Keep the transplanted oracle on the baseline's real maps");
const transplanted = original.replace(importBefore, importBefore.replace("createDesktopBackendRegistry }", "createDesktopBackendRegistry, registryModules }"))
  + "\n" + helper + '\n\ndescribe("Pre-phase-4 awaited start bookkeeping", () => {\n'
  + cases.map(node => node.getText(ast) + ";").join("\n") + "\n});\n";
let result;
try {
  writeFileSync(target, transplanted);
  result = spawnSync("pnpm", ["test", file, "-t", "start bookkeeping"], { cwd: proofRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
} finally {
  writeFileSync(target, original);
}
mkdirSync(".local/pwr-147", { recursive: true });
const log = (result.stdout ?? "") + (result.stderr ?? "");
writeFileSync(".local/pwr-147/baseline-bookkeeping-red.log", log);
assert.notEqual(result.status, 0, "The pre-change property must fail");
assert.match(log, /Property failed after/);
assert.match(log, /AssertionError/);
assert.doesNotMatch(log, /Failed Suites|invalid signature|Cannot find module|Failed to resolve import|Transform failed|TypeError|ReferenceError/);
const summary = { baseline, status: result.status, failingProperty: true,
  counterexample: log.match(/Counterexample:.*$/m)?.[0], replay: log.match(/\{ seed:.*$/m)?.[0],
  log: ".local/pwr-147/baseline-bookkeeping-red.log", restored: readFileSync(target, "utf8") === original };
writeFileSync(".local/pwr-147/baseline-bookkeeping-red.json", JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
