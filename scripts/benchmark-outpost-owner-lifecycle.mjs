// Matched full-command timings. Own an idle worktree and its node_modules;
// the two production files must be committed before this driver swaps them.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, release } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const baseline = option("--baseline-ref");
const phase = option("--phase", "paired");
const samples = Number(option("--samples", "7"));
if (!baseline || !/^[a-z0-9-]+$/.test(phase) || !Number.isInteger(samples) || samples < 1 || samples > 20) {
  throw new Error("Use --baseline-ref <commit> [--phase <simple-name>] [--samples <1..20>].");
}
const git = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8" });
const beforeCommit = git("rev-parse", "--verify", "--end-of-options", `${baseline}^{commit}`).trim();
const files = ["apps/desktop/src/main/settings/desktop-settings-service.ts", "apps/desktop/src/main/app-server/backend-registry-wiring.ts"];
if (git("status", "--porcelain", "--", ...files).trim()) throw new Error("Commit both production files before measuring; this driver must restore exact committed bytes.");
const after = files.map(file => readFileSync(path.join(root, file)));
const before = files.map(file => git("show", `${beforeCommit}:${file}`));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const directory = path.join(root, ".local/owner-lifecycle");
mkdirSync(directory, { recursive: true });
const lock = path.join(directory, "benchmark.lock");
mkdirSync(lock);
const restore = () => files.forEach((file, index) => writeFileSync(path.join(root, file), after[index]));
const commandArgs = ["test", "apps/desktop/src/main/__tests__/headless-host.boot.oracle.test.ts", "apps/desktop/src/main/__tests__/headless-concurrency.oracle.test.ts"];
const rows = [];
try {
  writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, phase }));
  writeFileSync(path.join(directory, `${phase}-source-backup.json`), JSON.stringify(files.map((file, index) => ({ file, source: after[index].toString() }))));
  writeFileSync(path.join(directory, `${phase}-environment.json`), JSON.stringify({
    head: git("rev-parse", "HEAD").trim(), beforeCommit,
    files: files.map((file, index) => ({ file, before: hash(before[index]), after: hash(after[index]) })),
    node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
    kernel: release(), cpus: availableParallelism(), command: ["pnpm", ...commandArgs],
    environmentHash: hash(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)))),
    method: "Run 0 is a separate setup pair; 1..N alternate before/after order. Fresh-process full normal commands, warm dependencies/Git/OS caches, no timing instrumentation or omitted setup. Only the two named production files swap.",
  }, null, 2));
  for (let run = 0; run <= samples; run++) {
    for (const mode of run % 2 ? ["after", "before"] : ["before", "after"]) {
      files.forEach((file, index) => writeFileSync(path.join(root, file), (mode === "before" ? before : after)[index]));
      const load = loadavg();
      const start = performance.now();
      const result = spawnSync("pnpm", commandArgs, { cwd: root, env: process.env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      const row = { run, mode, seconds: (performance.now() - start) / 1000, status: result.status, load };
      rows.push(row);
      writeFileSync(path.join(directory, `${phase}-timings.json`), JSON.stringify(rows, null, 2));
      writeFileSync(path.join(directory, `${phase}-${run}-${mode}.log`), ((result.stdout ?? "") + (result.stderr ?? "")).slice(-120_000));
      console.log(JSON.stringify(row));
      if (result.error || result.status !== 0) throw new Error(`Failed ${mode}/${run}; see bounded log: ${result.error?.message ?? result.status}`);
    }
  }
  const summarize = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    return { n: sorted.length, median: sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2, min: sorted[0], max: sorted.at(-1) };
  };
  const measured = rows.filter(row => row.run > 0);
  const changes = Array.from({ length: samples }, (_, index) => {
    const pair = measured.filter(row => row.run === index + 1);
    return pair.find(row => row.mode === "after").seconds - pair.find(row => row.mode === "before").seconds;
  });
  const summary = {
    before: summarize(measured.filter(row => row.mode === "before").map(row => row.seconds)),
    after: summarize(measured.filter(row => row.mode === "after").map(row => row.seconds)),
    pairedChange: summarize(changes), fasterPairs: changes.filter(change => change < 0).length,
  };
  writeFileSync(path.join(directory, `${phase}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  try { restore(); } finally { rmSync(lock, { recursive: true, force: true }); }
}
// A killed driver can leave a lock and swapped sources. Inspect owner.json and
// join its children before restoring the saved source bytes and removing it.
