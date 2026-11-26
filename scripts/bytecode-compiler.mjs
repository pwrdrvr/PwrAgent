import { spawn } from "node:child_process";
import { once } from "node:events";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import vm from "node:vm";
import { readJsonRpcLines } from "../apps/desktop/scripts/json-rpc-lines.mjs";
import { resolveLocalCpuBudget } from "./local-cpu-budget.mjs";

export const bytecodeBudget = 25 * 1024;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Vitest 5 module-evaluator context, including CJS globals. Do not substitute
// a bare ESM compilation: the context layout changes function bytecode.
export function wrapVitestModule(code) {
  const args = [
    "__vite_ssr_exports__", "__vite_ssr_import_meta__", "__vite_ssr_import__",
    "__vite_ssr_dynamic_import__", "__vite_ssr_exportAll__", "__vite_ssr_exportName__",
    "__filename", "__dirname", "module", "exports", "require",
  ];
  return `'use strict';async (${args.join(",")})=>{{${code}\n}}`;
}

// Eager compilation only. Neither modules nor their imports are evaluated.
async function compilerChild() {
  writeSync(1, `@@RUNTIME ${JSON.stringify(process.versions)}\n`);
  new vm.Script("0");
  new vm.SourceTextModule("export {};");
  const ended = once(process.stdin, "end");
  readJsonRpcLines(process.stdin, (line) => {
    const { file, variant, code, esm } = JSON.parse(line);
    writeSync(1, `@@FILE ${JSON.stringify({ file, variant })}\n`);
    setFlagsFromString("--print-bytecode --print-bytecode-filter=*");
    try {
      if (esm) new vm.SourceTextModule(code, { identifier: file });
      else new vm.Script(code, { filename: file });
    } finally {
      setFlagsFromString("--no-print-bytecode");
    }
  });
  await ended;
}

// One process compiles and prints every function on one core. Each module
// compiles alone, so its records do not depend on the modules beside it, and
// the modules are split across processes by source size.
export async function compileBytecode(modules, options = {}) {
  // V8 flushes the listing after every line. Into a pipe, each flush wakes
  // this process to read a few bytes. Linux takes the same writes into a
  // file more cheaply, so the listing goes there and is read once the
  // compiler exits. macOS writes a file this way far more slowly than a pipe.
  const listing = options.listing ?? (process.platform === "linux" ? "file" : "pipe");
  // This one process reads every pipe, and beyond two it is the limit.
  const defaultProcesses = listing === "file" ? availableParallelism() : Math.min(2, availableParallelism());
  const localBudget = resolveLocalCpuBudget({ cwd: options.cwd ?? repositoryRoot });
  const budgetCap = options.maxProcesses ?? localBudget?.units;
  const processes = options.processes ?? (budgetCap !== undefined ? Math.min(defaultProcesses, budgetCap) : defaultProcesses);
  const count = Math.max(1, Math.min(processes, modules.length));
  const shards = Array.from({ length: count }, () => ({ size: 0, modules: [] }));
  for (const module of [...modules].sort((a, b) => b.code.length - a.code.length)) {
    const shard = shards.reduce((least, candidate) => candidate.size < least.size ? candidate : least);
    shard.size += module.code.length;
    shard.modules.push(module);
  }
  // A failure in one process stops the others.
  const failure = new AbortController();
  const results = await Promise.all(shards.map((shard) => compileShard(shard.modules, { ...options, listing, signal: failure.signal })))
    .catch((error) => {
      failure.abort();
      throw error;
    });
  const key = ({ file, variant }) => JSON.stringify([file, variant]);
  const byModule = new Map();
  for (const record of results.flatMap((result) => result.records)) {
    if (!byModule.has(key(record))) byModule.set(key(record), []);
    byModule.get(key(record)).push(record);
  }
  // The caller's module order, whichever process compiled each module.
  return { runtime: results[0].runtime, records: [...new Set(modules.map(key))].flatMap((module) => byModule.get(module)) };
}

async function compileShard(modules, options) {
  const directory = options.listing === "file" ? mkdtempSync(join(tmpdir(), "bytecode-listing-")) : undefined;
  try {
    return await compileInto(directory && join(directory, "listing.txt"), modules, options);
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

async function compileInto(listing, modules, options) {
  const sink = listing ? openSync(listing, "w") : "pipe";
  let child;
  try {
    child = spawn(options.executable ?? process.execPath, [
      "--no-lazy", "--experimental-vm-modules", fileURLToPath(import.meta.url), "--compile",
    ], {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", sink, "pipe"],
      signal: options.signal,
    });
  } finally {
    if (listing) closeSync(sink);
  }
  const finished = once(child, "close");
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  const records = [];
  let runtime;
  let module;
  let record;
  const read = (line) => {
    if (line.startsWith("@@RUNTIME ")) runtime = JSON.parse(line.slice(10));
    else if (line.startsWith("@@FILE ")) {
      module = JSON.parse(line.slice(7));
      record = undefined;
    } else if (line.startsWith("[generated bytecode for function: ")) {
      record = { ...module, name: /^\[generated bytecode for function: (.*?) \(0x/.exec(line)?.[1] || "(anonymous)", positions: [] };
    } else if (record && line.startsWith("Bytecode length: ")) {
      record.bytes = Number(line.slice(17));
      records.push(record);
    } else if (record) {
      const position = /^\s*(\d+) [SE]>/.exec(line);
      if (position) record.positions.push(Number(position[1]));
    }
  };
  if (!listing) readJsonRpcLines(child.stdout, read);
  try {
    const sending = (async () => {
      for (const module of modules) {
        if (!child.stdin.write(JSON.stringify(module) + "\n")) await once(child.stdin, "drain");
      }
      child.stdin.end();
    })();
    const [, [exitCode]] = await Promise.all([sending, finished]);
    if (exitCode !== 0) throw new Error(`Bytecode compiler exited ${exitCode}: ${diagnostics}`);
    if (listing) {
      const stream = createReadStream(listing, { highWaterMark: 1 << 20 });
      readJsonRpcLines(stream, read);
      await once(stream, "close");
    }
    if (!runtime || records.length === 0) throw new Error("V8 returned no bytecode/runtime records");
    for (const module of modules) {
      if (!records.some((record) => record.file === module.file && record.variant === module.variant)) {
        throw new Error(`V8 returned no bytecode for ${module.file} (${module.variant})`);
      }
    }
    return { runtime, records };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--compile") await compilerChild();
