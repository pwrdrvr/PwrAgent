#!/usr/bin/env node
import { build } from "esbuild";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RULE = "desktop-owner-dependencies-do-not-require-electron";
function ownerFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(root, entry.name);
    if (entry.isDirectory()) return ["shell", "__tests__"].includes(entry.name) ? [] : ownerFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** Follow runtime package imports; dependency-cruiser deliberately stops at npm. */
export async function findElectronDependencies(entryPoints, repoRoot) {
  repoRoot = realpathSync(repoRoot);
  const findings = new Map();
  await build({
    entryPoints, outdir: resolve(repoRoot, ".local/owner-electron-boundary"), outbase: repoRoot,
    bundle: true, splitting: true, write: false, platform: "node", format: "esm", logLevel: "silent",
    loader: { ".node": "empty", ".wasm": "empty" },
    plugins: [{ name: RULE, setup(builder) {
      builder.onResolve({ filter: /^electron(?:\/|$)/ }, (args) => {
        findings.set(`${args.importer}:${args.path}`, { path: relative(repoRoot, args.importer).replaceAll("\\", "/"), module: args.path });
        return { path: args.path, external: true };
      });
      // Native/data files are not JavaScript modules and cannot import Electron.
      builder.onResolve({ filter: /\.(?:node|wasm)$/ }, (args) => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw-data" }));
      builder.onLoad({ filter: /.*/, namespace: "raw-data" }, (args) => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
    } }],
  });
  return [...findings.values()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = resolve(import.meta.dirname, "..");
  const main = resolve(repoRoot, "apps/desktop/src/main");
  const findings = await findElectronDependencies(ownerFiles(main).filter((file) => file !== resolve(main, "index.ts")), repoRoot);
  for (const finding of findings) console.error(`${RULE}: ${finding.path} imports ${finding.module}; use a Node package entry or a host port.`);
  if (findings.length) process.exitCode = 1;
  else console.log(`${RULE}: passed`);
}
