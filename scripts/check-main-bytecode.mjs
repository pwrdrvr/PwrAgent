#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { annotateBytecode } from "./bytecode-attribution.mjs";
import { bytecodeBudget, compileBytecode, wrapVitestModule } from "./bytecode-compiler.mjs";
import { resolveLocalCpuBudget } from "./local-cpu-budget.mjs";
import { discoverMainBytecodeSources, sourceFiles } from "./main-bytecode-scope.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a path`);
  return resolve(process.argv[index + 1]);
}

async function check() {
  const scope = argument("--scope");
  const custom = scope && JSON.parse(readFileSync(scope, "utf8"));
  const output = resolve(root, "apps/desktop/out/main");
  const productionPaths = custom ? (custom.productionFiles ?? []).map((file) => resolve(root, file)) : sourceFiles(output, { excludeTests: false }).filter((file) => /\.[cm]?js$/.test(file));
  if (productionPaths.some((file) => file.endsWith(".cjs"))) throw new Error("Shipped CommonJS output requires a distinct CJS compiler wrapper");
  const production = productionPaths.map((file) => ({
    file: relative(root, file).replaceAll("\\", "/"), variant: "production", esm: true,
    code: readFileSync(file, "utf8"), map: existsSync(file + ".map") ? JSON.parse(readFileSync(file + ".map", "utf8")) : undefined,
  }));
  if (!custom && production.length === 0) throw new Error("Build the shipped main output before checking bytecode");
  const additional = production.flatMap((module) => (module.map?.sources ?? []).filter((source) => !source.includes("node_modules/")).map((source) => resolve(dirname(resolve(root, module.file)), source)));
  const roots = custom ? custom.roots.map((file) => resolve(root, file)) : sourceFiles(resolve(root, "apps/desktop/src/main"));
  const discovery = discoverMainBytecodeSources(root, roots, additional);
  if (discovery.dynamic.length) throw new Error(`Nonliteral module imports cannot define a closed bytecode scope: ${JSON.stringify(discovery.dynamic)}`);
  const { createVitest } = await import("vitest/node");
  const context = await createVitest({ root, config: resolve(root, "vitest.workspace.mts"), project: ["desktop-main"], watch: false });
  try {
    await context.standalone();
    const environment = context.projects[0]?.vite.environments.ssr;
    if (!environment) throw new Error("The desktop-main SSR environment is missing");
    const modules = [];
    for (const file of discovery.sources) {
      const result = await environment.fetchModule(resolve(root, file));
      if (!("code" in result)) throw new Error(`No Vitest transform for ${file}`);
      const inlineMap = /sourceMappingURL=data:application\/json[^,]*;base64,([^\s]+)/.exec(result.code);
      modules.push({
        file, source: file, variant: "Vitest", code: wrapVitestModule(result.code),
        map: inlineMap ? JSON.parse(Buffer.from(inlineMap[1], "base64").toString("utf8")) : undefined,
        wrapperPrefixLength: wrapVitestModule("").indexOf("{{") + 2,
      });
    }
    console.log(`Transform complete: ${modules.length} test modules, ${production.length} production chunks`);
    const executable = createRequire(resolve(root, "apps/desktop/package.json"))("electron");
    const localBudget = resolveLocalCpuBudget({ cwd: root });
    let node;
    let electron;
    if (!production.length) {
      node = await compileBytecode(modules, { cwd: root, ...(localBudget ? { maxProcesses: localBudget.units } : {}) });
    } else if (localBudget && localBudget.units < 2) {
      node = await compileBytecode([...modules, ...production], { cwd: root, maxProcesses: 1 });
      electron = await compileBytecode(production, { cwd: root, executable, env: { ELECTRON_RUN_AS_NODE: "1" }, maxProcesses: 1 });
    } else if (localBudget) {
      const electronMax = Math.max(1, Math.floor(localBudget.units / 2));
      const nodeMax = Math.max(1, localBudget.units - electronMax);
      [node, electron] = await Promise.all([
        compileBytecode([...modules, ...production], { cwd: root, maxProcesses: nodeMax }),
        compileBytecode(production, { cwd: root, executable, env: { ELECTRON_RUN_AS_NODE: "1" }, maxProcesses: electronMax }),
      ]);
    } else {
      [node, electron] = await Promise.all([
        compileBytecode([...modules, ...production], { cwd: root }),
        compileBytecode(production, { cwd: root, executable, env: { ELECTRON_RUN_AS_NODE: "1" } }),
      ]);
    }
    console.log(`Node compilation complete: ${node.records.length} records`);
    console.log(`Electron compilation complete: ${electron?.records.length ?? 0} records`);
    const runtimeFiles = production.filter((module) => !module.map && /\/rolldown-runtime-[^/]+\.js$/.test(module.file)).map(({ file }) => file);
    const records = [];
    for (const [runtime, result, inputs] of [["Node", node, [...modules, ...production]], ["Electron", electron, production]]) {
      if (!result) continue;
      const grouped = new Map(inputs.map((module) => [`${module.variant}:${module.file}`, module]));
      const groups = new Map();
      for (const record of result.records) {
        const key = `${record.variant}:${record.file}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
      }
      for (const [key, group] of groups) records.push(...annotateBytecode(root, { ...grouped.get(key), runtimeFiles }, group).map((record) => ({ runtime, ...record })));
    }
    const packageRequire = createRequire(import.meta.resolve("vite"));
    const hash = (code) => createHash("sha256").update(code).digest("hex");
    const report = {
      budget: bytecodeBudget,
      machine: { platform: process.platform, arch: process.arch, os: os.release(), cpu: os.cpus()[0].model, cpus: os.cpus().length, memory: os.totalmem() },
      runtimes: { Node: node.runtime, Electron: electron?.runtime },
      toolchain: Object.fromEntries(["vite", "vitest", "rolldown"].map((name) => [name, packageRequire(`${name}/package.json`).version])),
      sources: discovery.sources,
      sourceHashes: Object.fromEntries(discovery.sources.map((file) => [file, hash(readFileSync(resolve(root, file)))])),
      dynamicImports: discovery.dynamic,
      productionFiles: production.map(({ file }) => file),
      compilations: [...modules, ...production].map(({ file, variant, code }) => ({ file, variant, sha256: hash(code) })),
      records,
    };
    const reportPath = argument("--report");
    if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    const failures = records.filter((record) => ["first-party", "unmapped"].includes(record.classification) && (!Number.isInteger(record.bytes) || record.bytes > bytecodeBudget));
    const unmapped = records.filter((record) => record.classification === "unmapped");
    for (const record of failures) console.error(`${record.source ?? record.file}:${record.line} ${record.name} (${record.runtime} ${record.variant}): ${record.bytes} bytes (budget ${bytecodeBudget})`);
    for (const runtime of ["Node", "Electron"]) {
      for (const variant of ["Vitest", "production"]) {
        const entries = records.filter((record) => record.runtime === runtime && record.variant === variant && record.classification === "first-party");
        if (entries.length) console.log(`${runtime} ${variant}: ${entries.length} first-party functions, maximum ${Math.max(...entries.map((entry) => entry.bytes))} bytes`);
      }
    }
    console.log(`${discovery.sources.length} source modules; ${production.length} shipped chunks; ${records.length} total compiler records; ${unmapped.length} unmapped functions`);
    // Missing source-map attribution is conservative: these functions retain
    // generated locations and the full budget, never an exclusion.
    if (failures.length) throw new Error(`${failures.length} main functions exceed the ${bytecodeBudget}-byte operational budget`);
    console.log(`Main function bytecode operational budget passed (${bytecodeBudget} bytes per function)`);
  } finally {
    await context.close();
  }
}

try { await check(); }
catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
