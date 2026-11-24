import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const gitPath = process.env.PWRAGENT_GIT_PATH;
assert(gitPath && path.isAbsolute(gitPath));
const scratch = await mkdtemp(path.join(os.tmpdir(), "stack git proof-"));
const output = path.resolve(`apps/desktop/out/main/.stack-git-probe-${process.pid}.cjs`);
const baseline = process.argv.includes("--baseline");
const compiled = process.argv.includes("--compiled");
const git = (...args) => execFileSync(gitPath, args, {
  cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

const replace = (source, needle, replacement) => {
  assert(source.includes(needle), `Missing probe point: ${needle}`);
  return source.replace(needle, replacement);
};

try {
  await build({
    entryPoints: ["apps/desktop/src/main/stacks/stack-reader.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    external: ["electron"],
    define: { "import.meta.url": "probeModuleUrl" },
    banner: { js: 'const probeModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
    plugins: [{
      name: "observe-stack-metadata",
      setup(builder) {
        builder.onLoad({ filter: /[/\\](pr-metadata-process|git-executable|windows-job-wrapper)\.ts$/ }, async ({ path: file }) => {
          let source = baseline && !file.endsWith("pr-metadata-process.ts")
            ? execFileSync(gitPath, ["show", `511460506fbbb8b1c1c5873926a95614590591a1:${path.relative(process.cwd(), file).replaceAll("\\", "/")}`], { encoding: "utf8" })
            : await readFile(file, "utf8");
          if (file.endsWith("pr-metadata-process.ts")) {
            source = replace(source, "waiting.add(job);", "waiting.add(job); globalThis.stackProbe('enqueue', job);");
            source = replace(source, "waiting.delete(next);", "waiting.delete(next); globalThis.stackProbe('admit', next);");
            source = replace(source, "await job.run(fileSlot);", "try { await job.run(fileSlot); } finally { globalThis.stackProbe('settle', job); }");
          } else if (file.endsWith("git-executable.ts")) {
            source = replace(source, 'stdio: ["pipe", "pipe", "pipe"],\n  });', 'stdio: ["pipe", "pipe", "pipe"],\n  });\n  child.once("spawn", () => globalThis.stackProbe("spawn", launch.command));');
          }
          return { contents: source, loader: "ts" };
        });
      },
    }],
  });
  const { StackReader, StackReadObservation } = (await import(pathToFileURL(output).href)).default;
  const root = path.join(scratch, "tracked");
  const linked = path.join(scratch, "linked checkout");
  git("init", "-b", "main", root);
  git("-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  git("-C", root, "worktree", "add", "-b", "feature", linked);
  const head = git("-C", root, "rev-parse", "HEAD");
  await writeFile(path.join(root, ".git", "gh-stack"), JSON.stringify({
    schemaVersion: 1, repository: "github.com:fixture/project",
    stacks: [{ trunk: { branch: "main", head }, branches: [{ branch: "feature", head, base: head }] }],
  }));
  const unrelated = path.join(scratch, "unrelated");
  git("init", unrelated);
  const directories = [linked];
  for (let index = 0; index < 24; index++) {
    const cwd = path.join(index % 2 ? unrelated : scratch, `directory-${index}`);
    if (index % 3) await mkdir(cwd);
    directories.push(cwd);
  }
  const threads = directories.map((cwd, index) => ({
    id: String(index), source: "codex", title: "Fixture",
    linkedDirectories: [{ id: cwd, label: "Fixture", kind: "worktree", path: root, worktreePath: cwd }],
  }));
  const samples = {};
  const trace = path.join(scratch, "trace.jsonl");
  const record = async (name, reader, scope, priority) => {
    await rm(trace, { force: true });
    process.env.GIT_TRACE2_EVENT = trace;
    const queued = new Map();
    const active = new Map();
    let waitMs = 0;
    let slotMs = 0;
    let peakQueued = 0;
    let peakActive = 0;
    let powershell = 0;
    let launches = 0;
    globalThis.stackProbe = (event, value) => {
      const now = performance.now();
      if (event === "enqueue") {
        queued.set(value, now);
        peakQueued = Math.max(peakQueued, queued.size);
      } else if (event === "admit") {
        waitMs += now - queued.get(value);
        queued.delete(value);
        active.set(value, now);
        peakActive = Math.max(peakActive, active.size);
      } else if (event === "settle") {
        slotMs += now - active.get(value);
        active.delete(value);
      } else if (event === "spawn") {
        launches++;
        if (path.basename(value).toLowerCase() === "powershell.exe") powershell++;
      }
    };
    const start = performance.now();
    const result = await reader.read(threads, [], scope, undefined, new StackReadObservation({
      signal: new AbortController().signal, priority: () => priority,
    }));
    const wall = performance.now() - start;
    assert.equal(result.stacks.length, 1);
    assert.equal(result.stacks[0].layers[0].thread.key, "codex:0");
    assert.equal(active.size + queued.size, 0);
    const gitStarts = (await readFile(trace, "utf8")).split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line)).filter(({ event }) => event === "start").length;
    if (compiled) {
      assert.equal(powershell, 0, "Cancellable stack reads should start no PowerShell hosts");
      assert.equal(launches, gitStarts, "Each owned launch should start one Git command");
    }
    (samples[name] ??= []).push({ wall, launches, powershell, gitStarts, slotMs, waitMs, peakActive, peakQueued });
  };
  for (let index = 0; index < 7; index++) {
    const fleet = new StackReader();
    await record("cold fleet", fleet, undefined, 1);
    await record("warm fleet", fleet, undefined, 1);
    await record("selected", fleet, [linked], 2);
  }
  console.log(`${baseline ? "Baseline" : "Candidate"}: ${os.type()} ${os.release()} ${process.arch}; ${git("--version")}; ${process.version}`);
  for (const [name, rows] of Object.entries(samples)) {
    const metrics = Object.fromEntries(Object.keys(rows[0]).map((field) => {
      const values = rows.map((row) => row[field]).sort((left, right) => left - right).map(Math.round);
      return [field, { median: values[3], min: values[0], max: values[6] }];
    }));
    console.log(`${name}: ${JSON.stringify(metrics)}`);
  }
} finally {
  await rm(output, { force: true });
  await rm(scratch, { recursive: true, force: true });
}
