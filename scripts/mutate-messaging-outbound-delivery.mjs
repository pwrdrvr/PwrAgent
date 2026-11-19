import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const core = "apps/desktop/src/main/messaging/core";
const tests = "apps/desktop/src/main/__tests__";
const suites = ["messaging-outbound-delivery.property.test.ts", "messaging-controller.test.ts"];
const delivery = "messaging-outbound-delivery.ts";
const controller = "messaging-controller.ts";
const mutations = [
  {
    name: "unsafe-replay",
    file: delivery,
    test: "honors the provider deadline",
    replacements: [["if (result.rateLimit.retryable === true)", "if (result.rateLimit.retryable === false)"]],
  },
  {
    name: "late-cancellation-ignored",
    file: delivery,
    test: "settles an in-flight adapter result",
    replacements: [[`      if (guard?.isCancelled()) {
        await guard.onCancelledDelivery?.(result);
        return cancelledResult();
      }
`, ""]],
  },
  {
    name: "stale-store",
    file: delivery,
    test: "uses the store installed",
    replacements: [
      ["const result = await adapter.deliver(routedIntent);", "const store = this.options.store;\n      const result = await adapter.deliver(routedIntent);"],
      ["await this.options.store.recordDelivery({", "await store.recordDelivery({"],
    ],
  },
  {
    name: "artifact-caller-skipped",
    file: controller,
    test: "retries plan artifact delivery as inline preview",
    replacements: [[
      "deliverArtifactForBinding: (...args) => this.outboundDelivery.deliverArtifactForBinding(...args),",
      "deliverArtifactForBinding: async () => {},",
    ]],
  },
];

const root = resolve(".");
const evidence = resolve(".local/pwr-149-outbound-delivery/mutations");
mkdirSync(evidence, { recursive: true });
const logs = mkdtempSync(join(evidence, "run-"));
const temp = mkdtempSync(join(tmpdir(), "pwragent-outbound-delivery-"));
const checkout = join(temp, "checkout");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
const head = git(root, "rev-parse", "HEAD").toString().trim();
const patch = git(root, "diff", "--binary", "HEAD", "--");
const env = { ...process.env };
delete env.UPDATE_TURN_EVENT_STREAM;
delete env.UPDATE_SQLITE_WRITE_BUDGETS;

function pnpm(log, ...args) {
  const fd = openSync(log, "w");
  try {
    const result = spawnSync("pnpm", args, { cwd: checkout, env, stdio: ["ignore", fd, fd] });
    if (result.error) throw result.error;
    return result.status;
  } finally {
    closeSync(fd);
  }
}

function run(name, pattern) {
  const log = join(logs, name + ".log");
  const reportPath = join(logs, name + ".json");
  const status = pnpm(log, "test", ...suites.map(suite => join(tests, suite)),
    ...(pattern ? [`--testNamePattern=${pattern}`] : []),
    "--reporter=default", "--reporter=json", `--outputFile=${reportPath}`);
  if (!existsSync(reportPath)) throw new Error(`${name}: missing test report; see ${log}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const results = report.testResults.flatMap(file => file.assertionResults);
  const failures = results.filter(test => test.status === "failed");
  if (pattern) {
    const messages = failures.flatMap(failure => failure.failureMessages).join("\n");
    if (status !== 1 || failures.length === 0 || failures.some(test => !test.fullName.includes(pattern))
      || !/AssertionError:/.test(readFileSync(log, "utf8"))
      || /TypeError|ReferenceError|Transform failed|Test timed out|Failed to (?:load|import|resolve)/.test(messages)) {
      throw new Error(`${name}: expected an assertion failure in ${pattern}; see ${log}`);
    }
  } else if (status !== 0 || report.success !== true || failures.length !== 0
    || suites.some(suite => !report.testResults.some(file => file.name.endsWith("/" + suite)
      && file.assertionResults.some(test => test.status === "passed")))) {
    throw new Error(`Unmutated suites must pass; see ${log}`);
  }
  console.log(JSON.stringify({ name, status, passed: report.numPassedTests, failed: failures.length, log }));
  return results.filter(test => test.status === "passed");
}

try {
  // Staging new files includes them in the tracked patch. The live worktree
  // is only read, so interruption cannot leave a mutated file there.
  git(root, "clone", "--quiet", "--shared", "--no-checkout", "--", root, checkout);
  git(checkout, "checkout", "--quiet", "--detach", head);
  if (patch.length) execFileSync("git", ["apply", "--binary", "-"], { cwd: checkout, input: patch });
  const installLog = join(logs, "install.log");
  if (pnpm(installLog, "install", "--frozen-lockfile") !== 0) throw new Error(`Install failed; see ${installLog}`);
  const clean = run("unmutated");
  for (const { name, file, test, replacements } of mutations) {
    if (!clean.some(result => result.fullName.includes(test))) throw new Error(`${name}: no passing clean target`);
    const path = join(checkout, core, file);
    const original = readFileSync(path, "utf8");
    let mutated = original;
    for (const [from, to] of replacements) {
      if (mutated.split(from).length !== 2) throw new Error(`${name}: mutation site must be unique`);
      mutated = mutated.replace(from, to);
    }
    writeFileSync(path, mutated);
    try { run(name, test); }
    finally { writeFileSync(path, original); }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
