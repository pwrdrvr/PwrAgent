// Temporary, finite diagnostic for PR #3420. Run both exact revisions with
// identical tracing; do not change their timeout, worker, or shard settings.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
if (args.length !== 3) {
  throw new Error("Usage: node messaging-cold-start.mjs BASELINE CANDIDATE OUTPUT");
}
const [baseline, candidate, output] = args.map((value) => resolve(value));
mkdirSync(output, { recursive: true });
const test = "apps/desktop/src/main/__tests__/messaging-runtime.test.ts";
const patch = join(dirname(fileURLToPath(import.meta.url)), "fixtures/messaging-cold-start.patch");
const git = (cwd, argv) => {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
};
const variants = [["baseline", baseline], ["candidate", candidate]];
const metadata = {
  node: process.version,
  platform: process.platform,
  processor: cpus()[0]?.model,
  logicalCpus: cpus().length,
  ramBytes: totalmem(),
  runId: process.env.GITHUB_RUN_ID,
  method: "One lane 2/4 run per revision, then one fresh-process focused test per revision. Default workers and existing test deadlines. No retries. Filesystem caches may be warmer for later runs.",
  revisions: variants.map(([variant, cwd]) => ({ variant, sha: git(cwd, ["rev-parse", "HEAD"]) })),
  testHashes: variants.map(([variant, cwd]) => ({ variant,
    sha256: createHash("sha256").update(readFileSync(join(cwd, test))).digest("hex") })),
};
if (new Set(metadata.testHashes.map((entry) => entry.sha256)).size !== 1) {
  throw new Error("Expected byte-identical pre-instrumentation test files");
}
writeFileSync(join(output, "metadata.json"), JSON.stringify(metadata, null, 2));
for (const [, cwd] of variants) {
  git(cwd, ["apply", "--check", patch]);
  git(cwd, ["apply", patch]);
}

const samples = [];
try {
  for (const slice of ["lane", "focused"]) {
    for (const [variant, cwd] of variants) {
      const label = `${variant}-${slice}`;
      const log = join(output, `${label}.log`);
      const fd = openSync(log, "w");
      const command = ["test", ...(slice === "lane" ? ["--shard=2/4"] : [test, "-t",
        "starts configured adapters and routes inbound events through channel controllers"]),
        "--reporter=default", "--reporter=json", `--outputFile=${join(output, `${label}.json`)}`];
      const started = performance.now();
      const loadSamples = [{ elapsedMs: 0, load: loadavg() }];
      const sampler = setInterval(() => {
        loadSamples.push({ elapsedMs: performance.now() - started, load: loadavg() });
      }, 1_000);
      let status;
      try {
        status = await new Promise((resolveStatus, reject) => {
          const child = spawn("pnpm", command, { cwd, env: process.env, stdio: ["ignore", fd, fd] });
          child.once("error", reject);
          child.once("exit", (code, signal) => resolveStatus({ code, signal }));
        });
      } finally {
        clearInterval(sampler);
        closeSync(fd);
      }
      const phases = [...readFileSync(log, "utf8").matchAll(/\[messaging-startup\] (\{[^\n]+\})/g)]
        .map((match) => JSON.parse(match[1]));
      const sample = { variant, slice, command, ...status,
        elapsedMs: performance.now() - started, phases, loadSamples };
      samples.push(sample);
      writeFileSync(join(output, "samples.json"), JSON.stringify({ metadata, samples }, null, 2));
      console.log(JSON.stringify({ variant, slice, ...status, phases }));
    }
  }
} finally {
  for (const [, cwd] of variants) git(cwd, ["apply", "--reverse", patch]);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\nFinite PR #3420 cold-start comparison. Exact SHAs, phase transitions, lane/focused JSON reports, raw logs and load samples are in the artifact. No timeout or concurrency changes.\n");
}
if (samples.some((sample) => sample.code !== 0)) process.exitCode = 1;
