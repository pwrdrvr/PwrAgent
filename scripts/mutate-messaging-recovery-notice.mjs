import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Run from the repository root after selecting the pinned Node version.
// --pre-fix proves the regression against the actual reviewed production.
const baseline = "f66cf3200bf11ef2689f0de6137830e46be29171";
const core = "apps/desktop/src/main/messaging/core/";
const tests = "apps/desktop/src/main/__tests__/";
const directory = ".local/pwr-149-canonical-queue/review-notice-mutations";
mkdirSync(directory, { recursive: true });
const protectedPaths = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(file => `${tests}fixtures/${file}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedBefore = protectedPaths.map(hash);
const files = ["messaging-queue-recoveries.ts", "messaging-callback-handlers.ts", "messaging-controller.ts"];
const originals = new Map(files.map(file => [file, readFileSync(core + file, "utf8")]));
const mutations = [
  ["settlement-loses-latest-entry", files[0],
    'state.outcome === "accepted" ? state.entry : undefined', 'state.outcome === "accepted" ? undefined : undefined'],
  ["steer-retires-claimed-entry", files[1],
    'retireQueuedTurnNotice(retiredEntry, "Queued message was sent as a steering message.", event)',
    'retireQueuedTurnNotice(entry, "Queued message was sent as a steering message.", event)'],
  ["retry-retires-claimed-entry", files[1],
    'retireQueuedTurnNotice(retiredEntry, result === "queued"', 'retireQueuedTurnNotice(entry, result === "queued"'],
  ["callback-message-surface-lost", files[2],
    'entry.surface ?? event?.sourceSurface ?? event?.interaction', 'entry.surface ?? event?.interaction'],
];
function prove(name) {
  const log = `${directory}/${name}.log`;
  const report = resolve(`${directory}/${name}.json`);
  const fd = openSync(log, "w");
  let result;
  try {
    result = spawnSync("pnpm", ["test", `${tests}messaging-recovery-notice.property.test.ts`,
      "--reporter=default", "--reporter=json", `--outputFile=${report}`], { stdio: ["ignore", fd, fd] });
  } finally { closeSync(fd); }
  if (result.error) throw result.error;
  const data = JSON.parse(readFileSync(report, "utf8"));
  const failed = data.testResults.flatMap(file => file.assertionResults).filter(test => test.status === "failed");
  const output = readFileSync(log, "utf8");
  const messages = failed.flatMap(test => test.failureMessages).join("\n");
  if (result.status === 0 || !failed.length || !/AssertionError:/.test(output)
    || /TypeError|ReferenceError|Transform failed|Test timed out|Failed to (?:load|resolve|import)/.test(messages)
    || /(?:Caused by: )?(?:TypeError|ReferenceError):|Test timed out/.test(output)) {
    throw new Error(`${name}: expected an assertion failure; inspect ${log}`);
  }
  const proof = { name, exit: result.status, failedAssertions: failed.length, log };
  console.log(JSON.stringify(proof));
  return proof;
}
const results = [];
const preFix = process.argv.includes("--pre-fix");
try {
  if (preFix) {
    for (const file of files) writeFileSync(core + file, execFileSync("git", ["show", `${baseline}:${core + file}`]));
    results.push(prove("reviewed-production"));
  } else {
    for (const [name, file, from, to] of mutations) {
      const source = originals.get(file);
      if (source.split(from).length !== 2) throw new Error(`${name}: expected one mutation site`);
      writeFileSync(core + file, source.replace(from, to));
      try { results.push(prove(name)); }
      finally { writeFileSync(core + file, source); }
    }
  }
} finally {
  for (const [file, source] of originals) writeFileSync(core + file, source);
  if (protectedPaths.some((file, index) => hash(file) !== protectedBefore[index])) throw new Error("Protected fixture changed");
  writeFileSync(`${directory}/${preFix ? "pre-fix" : "mutation"}-summary.json`,
    JSON.stringify({ baseline, results, protectedBefore }, null, 2) + "\n");
}
