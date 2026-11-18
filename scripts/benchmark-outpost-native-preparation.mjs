// Reproduce native preparation costs without changing the production builder.
// Logs are bounded; the caller owns an otherwise idle checkout and its outputs.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, release } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!["darwin", "linux"].includes(process.platform)) throw new Error("Outpost package measurements require a native macOS or Linux host.");
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const phase = option("--phase", "sample");
const samples = Number(option("--samples", "5"));
if (!/^[a-z0-9-]+$/.test(phase) || !Number.isInteger(samples) || samples < 1 || samples > 20) {
  throw new Error("Use --phase <simple-name> and --samples <1..20>.");
}
const directory = path.join(root, ".local/native-helper-cache");
mkdirSync(directory, { recursive: true });
const lock = path.join(directory, "benchmark.lock");
// Do not run two measurement drivers against shared package outputs. An
// interrupted driver leaves an explicit lock for its operator to inspect.
mkdirSync(lock);
try {
  writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  const helper = path.join(root, "packages/pwragent/build/mcp-ipc-relay/packaged");
  const environment = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
    os: release(), cpus: availableParallelism(),
    note: "Run 0 is separate setup; 1..N are fresh-process full builds. Native-cold removes only the helper directory. Dependencies and staged Git are warm; no OS cache eviction or dependency/network setup is measured.",
  };
  writeFileSync(path.join(directory, `${phase}-environment.json`), JSON.stringify(environment, null, 2));
  const cases = {
    helper: [process.execPath, ["--input-type=module", "-e", `import { buildMcpIpcRelay } from './apps/desktop/scripts/build-mcp-ipc-relay.mjs'; buildMcpIpcRelay({outputRoot:${JSON.stringify(path.join(root, "packages/pwragent"))},packaged:true,reuse:${args.includes("--native-reuse")}});`]],
    package: [process.execPath, ["packages/pwragent/scripts/build.mjs"]],
    owner: ["pnpm", ["test", "apps/desktop/src/main/__tests__/headless-host.boot.oracle.test.ts", "apps/desktop/src/main/__tests__/headless-concurrency.oracle.test.ts"]],
  };
  const rows = [];
  for (let run = 0; run <= samples; run++) {
    for (const [name, [command, commandArgs]] of Object.entries(cases)) {
      for (const state of ["cold", "warm"]) {
        if (state === "cold") rmSync(helper, { recursive: true, force: true });
        const start = performance.now();
        const result = spawnSync(command, commandArgs, { cwd: root, env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        const row = { phase, name, state, run, seconds: (performance.now() - start) / 1000, status: result.status, command: [command, ...commandArgs] };
        rows.push(row);
        writeFileSync(path.join(directory, `${phase}-timings.json`), JSON.stringify(rows, null, 2));
        writeFileSync(path.join(directory, `${phase}-${name}-${state}-${run}.log`), ((result.stdout ?? "") + (result.stderr ?? "")).slice(-120_000));
        console.log(JSON.stringify(row));
        if (result.error || result.status !== 0) throw new Error(`Failed ${name}/${state}/${run}; see bounded log: ${result.error?.message ?? result.status}`);
      }
    }
  }

  // This deliberately measures only a lower bound for one conservative cache
  // design. It never returns a cached helper or omits a production compile.
  // A full cache would also need linker/SDK/toolchain, flags/environment,
  // source/build-script, integrity and concurrent ownership validation.
  const compiler = option("--compiler");
  if (compiler) {
    const executable = realpathSync(compiler);
    const flags = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
      ...(process.platform === "darwin" ? ["-mmacosx-version-min=12.0", "-arch", process.arch === "x64" ? "x86_64" : process.arch] : [])];
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const output = path.join(helper, "mcp-ipc-relay");
    if (!existsSync(output)) throw new Error("The measured package build must provide a native helper.");
    const probes = [];
    for (let run = 0; run <= samples; run++) {
      const start = performance.now();
      const expanded = execFileSync("cc", [...flags, "-E", "apps/desktop/native/mcp-ipc-relay/main.c"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      const preprocessingMs = performance.now() - start;
      const compilerHash = hash(readFileSync(executable));
      const compilerHashMs = performance.now() - start - preprocessingMs;
      const sourceHash = hash(expanded);
      const outputHash = hash(readFileSync(output));
      probes.push({ run, ms: performance.now() - start, preprocessingMs, compilerHashMs, compilerHash, sourceHash, outputHash });
    }
    writeFileSync(path.join(directory, `${phase}-reuse-floor.json`), JSON.stringify({ compiler: executable, compilerBytes: statSync(executable).size, probes }, null, 2));
  }

  const summarize = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    return { median: sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2, min: sorted[0], max: sorted.at(-1) };
  };
  const summary = {};
  for (const name of Object.keys(cases)) {
    for (const state of ["cold", "warm"]) {
      summary[`${name}/${state}`] = summarize(rows.filter((row) => row.run > 0 && row.name === name && row.state === state).map((row) => row.seconds));
    }
  }
  writeFileSync(path.join(directory, `${phase}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  rmSync(lock, { recursive: true, force: true });
}
