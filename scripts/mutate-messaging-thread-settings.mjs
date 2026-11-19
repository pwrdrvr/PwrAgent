import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const core = "apps/desktop/src/main/messaging/core";
const tests = "apps/desktop/src/main/__tests__";
const suites = ["messaging-thread-settings.property.test.ts", "messaging-controller.test.ts"];
const settings = "messaging-thread-settings.ts";
const controller = "messaging-controller.ts";
const mutations = [
  {
    name: "full-access-gate-skipped",
    file: settings,
    test: "persists approved mode changes before the owning backend call",
    replacements: [['if (executionMode === "full-access") {', 'if (false) {']],
  },
  {
    name: "backend-reasoning-ignored",
    file: settings,
    test: "waits for the backend model response",
    replacements: [["const reasoningEffort = settingsResponse?.reasoningEffort;", "const reasoningEffort = undefined;"]],
  },
  {
    name: "callback-drops-model-selection",
    file: controller,
    test: "opens a model picker and stores the selected model",
    replacements: [[
      "setBindingModel: (...args) => this.threadSettings.setBindingModel(...args),",
      "setBindingModel: async () => {},",
    ]],
  },
];

const root = resolve(".");
const evidence = resolve(".local/pwr-149-settings/mutations");
mkdirSync(evidence, { recursive: true });
const logs = mkdtempSync(join(evidence, "run-"));
const temp = mkdtempSync(join(tmpdir(), "pwragent-settings-"));
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
    const options = { cwd: checkout, env, stdio: ["ignore", fd, fd] };
    let result;
    if (process.platform === "win32") {
      // cmd finds pnpm.exe or pnpm.cmd. Expand each argument inside its own
      // quotes so a pattern or report path containing spaces stays one token.
      const commandEnv = { ...env };
      const quotedArgs = args.map((arg, index) => {
        const key = `PWRAGENT_MUTATION_ARG_${index}`;
        commandEnv[key] = arg;
        return `"%${key}%"`;
      });
      result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/v:off", "/c", `pnpm ${quotedArgs.join(" ")}`], {
        ...options, env: commandEnv, windowsVerbatimArguments: true,
      });
    } else {
      result = spawnSync("pnpm", args, options);
    }
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
    || suites.some(suite => !report.testResults.some(file => file.name.replaceAll("\\", "/").endsWith("/" + suite)
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
  // The mutation suites do not use the LFS-backed visual baselines.
  execFileSync("git", ["checkout", "--quiet", "--detach", head], {
    cwd: checkout,
    env: { ...env, GIT_LFS_SKIP_SMUDGE: "1" },
  });
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
