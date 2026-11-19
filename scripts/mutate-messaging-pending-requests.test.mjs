import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const runner = fileURLToPath(new URL("./mutate-messaging-pending-requests.mjs", import.meta.url));
const core = "apps/desktop/src/main/messaging/core";
const workflow = core + "/messaging-pending-request-workflow.ts";
const files = ["messaging-controller.ts", "messaging-pending-request-workflow.ts", "messaging-pending-request-context.ts", "messaging-pending-request-helpers.ts"];
const suites = ["messaging-pending-request-observable.property.test.ts",
  "messaging-pending-request-workflow.test.ts", "messaging-pending-request-helpers.property.test.ts"];

function runFixture(mode) {
  const directory = mkdtempSync(join(tmpdir(), "pwragent-mutation-runner-test-"));
  const checkout = join(directory, "checkout");
  const bin = join(directory, "bin");
  const trace = join(directory, "test-runs.jsonl");
  const write = (file, content) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  try {
    for (const file of files) {
      write(join(checkout, core, file), readFileSync(new URL("../" + core + "/" + file, import.meta.url)));
    }
    for (const name of ["turn-event-stream.json", "sqlite-write-budgets.json"]) {
      write(join(checkout, "apps/desktop/src/main/__tests__/fixtures", name), "{}\n");
    }
    // Give the stub the same test names the real Vitest run reports.
    const suiteNames = Object.fromEntries(suites.map(file => {
      const path = "apps/desktop/src/main/__tests__/" + file;
      const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
      return [path, [...source.matchAll(/^ *it\("([^"]+)"/gm)].map(match => match[1])];
    }));
    const git = (...args) => execFileSync("git", args, { cwd: checkout, stdio: "pipe" });
    git("init", "--quiet");
    git("add", "apps");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture checkout");
    const before = readFileSync(join(checkout, workflow), "utf8") + "\n// uncommitted tracked edit\n";
    write(join(checkout, workflow), before);
    write(join(bin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "install") process.exit(0);
if (args[0] !== "test") process.exit(2);
const source = fs.readFileSync(${JSON.stringify(workflow)}, "utf8");
const mutated = source.includes("void context.host;");
const paths = args.filter(arg => arg.endsWith(".test.ts"));
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ mutated, paths, sawEdit: source.includes("uncommitted tracked edit") }) + "\\n");
if (${JSON.stringify(mode)} === "interrupt" && mutated) {
  process.kill(process.ppid, "SIGINT");
  process.exit(130);
}
const failed = ${JSON.stringify(mode)} === "already-failing";
const output = args.find(arg => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
const suites = ${JSON.stringify(suiteNames)};
fs.writeFileSync(output, JSON.stringify({
  success: !failed,
  numPassedTests: failed ? 0 : paths.length,
  testResults: paths.map(name => ({ name: require("node:path").resolve(name), assertionResults: suites[name].map(fullName => ({
    fullName,
    status: failed ? "failed" : "passed",
    failureMessages: failed ? ["AssertionError: pre-existing failure"] : [],
  })) })),
}));
if (failed) console.error("AssertionError: pre-existing failure");
process.exit(failed ? 1 : 0);
`);
    chmodSync(join(bin, "pnpm"), 0o755);
    const result = spawnSync(process.execPath, [runner], {
      cwd: checkout, encoding: "utf8", env: { ...process.env, PATH: bin + delimiter + process.env.PATH, TMPDIR: directory },
    });
    if (result.error) throw result.error;
    const runs = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    return { result, before, after: readFileSync(join(checkout, workflow), "utf8"), runs };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("keeps the source checkout intact when a mutation run receives SIGINT", () => {
  const { result, before, after, runs } = runFixture("interrupt");
  expect(runs.some(run => run.mutated)).toBe(true);
  expect(runs.every(run => run.sawEdit)).toBe(true);
  expect(result.signal).toBe("SIGINT");
  expect(after).toBe(before);
});

it.skipIf(process.platform === "win32")("refuses to credit any mutation when the clean suites fail", () => {
  const { result, before, after, runs } = runFixture("already-failing");
  expect(result.status).toBe(1);
  expect(runs.map(run => run.mutated)).toEqual([false]);
  expect(runs[0].paths).toHaveLength(3);
  expect(result.stdout).not.toContain('"failedAssertions":1');
  expect(after).toBe(before);
});
