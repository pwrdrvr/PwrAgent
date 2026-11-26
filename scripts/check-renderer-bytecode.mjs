#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileBytecode, wrapVitestModule } from "./bytecode-compiler.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const rendererRoot = resolve(repoRoot, "apps/desktop/src/renderer/src");

async function checkBytecode() {
  // Keep TypeScript's scope parser out of the eager compiler subprocess.
  const { discoverRendererBytecodeSources, rendererBytecodeBudget: bytecodeBudget, rendererBytecodeRoots } = await import("./renderer-bytecode-scope.mjs");
  const scopeIndex = process.argv.indexOf("--scope");
  if (scopeIndex !== -1 && !process.argv[scopeIndex + 1]) throw new Error("--scope requires a path");
  const scope = scopeIndex === -1 ? {
    roots: rendererBytecodeRoots,
    boundaries: JSON.parse(readFileSync(new URL("./renderer-bytecode-boundaries.json", import.meta.url), "utf8")),
  } : JSON.parse(readFileSync(process.argv[scopeIndex + 1], "utf8"));
  const components = scope.roots.map(([name, file]) => [name, `apps/desktop/src/renderer/src/${file}`]);
  const { createVitest } = await import("vitest/node");
  const viteRequire = createRequire(import.meta.resolve("vite"));
  const { minifySync } = await import(pathToFileURL(viteRequire.resolve("rolldown/utils")).href);
  const context = await createVitest({
    root: repoRoot,
    config: resolve(repoRoot, "vitest.workspace.mts"),
    project: ["desktop-renderer"],
    watch: false,
  });
  try {
    await context.standalone();
    const environment = context.projects[0]?.vite.environments.ssr;
    if (!environment) throw new Error("The desktop-renderer SSR environment is missing");
    const modules = [];
    const boundaries = scope.boundaries;
    const sources = discoverRendererBytecodeSources(rendererRoot, scope.roots.map(([, file]) => file), boundaries);
    for (const source of sources) {
      const file = `apps/desktop/src/renderer/src/${source}`;
      const result = await environment.fetchModule(resolve(repoRoot, file));
      if (!("code" in result)) throw new Error(`No transformed code for ${file}`);
      const code = wrapVitestModule(result.code);
      modules.push({ file, variant: "Vitest", code });
      // Preserve the wrapper as an observable value during compression. This
      // assignment is only compiled, never executed or installed on globalThis.
      const minified = minifySync(file, code.replace("async (", "globalThis.__rendererBytecodeModule = async ("), {
        compress: true,
        mangle: false,
      });
      if (minified.errors.length > 0) throw new Error(`Could not minify ${file}`);
      modules.push({ file, variant: "minified", code: minified.code });
    }

    const { records } = await compileBytecode(modules, { cwd: repoRoot });

    const reportIndex = process.argv.indexOf("--report");
    if (reportIndex !== -1) {
      if (!process.argv[reportIndex + 1]) throw new Error("--report requires a path");
      writeFileSync(process.argv[reportIndex + 1], JSON.stringify({ budget: bytecodeBudget, node: process.version, v8: process.versions.v8, sources, boundaries, records }, null, 2) + "\n");
    }

    for (const [component, file] of components) {
      const record = records.find((entry) => entry.file === file && entry.variant === "Vitest" && entry.name === component);
      if (!record) throw new Error(`V8 did not report bytecode for ${component}`);
      const minified = records.filter((entry) => entry.file === file && entry.variant === "minified");
      if (minified.length < 2) throw new Error(`V8 did not report minified functions for ${file}`);
      const ordinary = records.filter((entry) => entry.file === file && entry.variant === "Vitest");
      const ordinaryMaximum = Math.max(...ordinary.map((entry) => entry.bytes));
      const maximum = Math.max(...minified.map((entry) => entry.bytes));
      console.log(`${component}: ${record.bytes.toLocaleString("en-US")} bytes; file maxima ${ordinaryMaximum.toLocaleString("en-US")} Vitest / ${maximum.toLocaleString("en-US")} minified`);
    }
    const failures = records.filter((record) => !Number.isInteger(record.bytes) || record.bytes > bytecodeBudget);
    for (const record of failures) {
      console.error(`${record.file}: ${record.name} (${record.variant}) uses ${record.bytes} bytes (budget ${bytecodeBudget})`);
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} renderer functions exceed the ${bytecodeBudget}-byte budget`);
    }
    console.log(`Renderer bytecode budget passed for all ${records.length} compiled functions in ${sources.length} modules`);
  } finally {
    await context.close();
  }
}

try {
  await checkBytecode();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
