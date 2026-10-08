#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const mainOutputDirectory = path.resolve(desktopRoot, "out", "main");
const entries = await readdir(mainOutputDirectory, { withFileTypes: true });
const javascriptFiles = entries
  .filter((entry) => entry.isFile() && /\.(?:c|m)?js$/.test(entry.name))
  .map((entry) => path.join(mainOutputDirectory, entry.name));
const forbidden = [
  {
    label: "externalized ws runtime import",
    pattern: /\b(?:from\s+|import\(|require\()["']ws["']/,
  },
  {
    label: "externalized workspace bundled-dependency import",
    pattern:
      /\b(?:from\s+|import\(|require\()["']@pwragent\/(?:shared|messaging-interface|messaging-provider-[^/"']+)["']/,
  },
];
const violations = [];

for (const filePath of javascriptFiles) {
  const contents = await readFile(filePath, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(contents)) {
      violations.push({
        file: path.relative(desktopRoot, filePath),
        label: rule.label,
      });
    }
  }
}

// Every preload runs sandboxed, where `require` resolves only Electron's own
// modules. When two preload entries share code, Rollup splits it into
// `out/preload/chunks/`, and each entry's `require("./chunks/...")` throws at
// load. The main window then has no desktop API and the app cannot start.
const preloadOutputDirectory = path.resolve(desktopRoot, "out", "preload");
const preloadFiles = (await readdir(preloadOutputDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.(?:c|m)?js$/.test(entry.name))
  .map((entry) => path.join(preloadOutputDirectory, entry.name));
for (const filePath of preloadFiles) {
  const contents = await readFile(filePath, "utf8");
  for (const [, specifier] of contents.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
    if (specifier !== "electron") {
      violations.push({
        file: path.relative(desktopRoot, filePath),
        label: `sandboxed preload requires "${specifier}"; keep each preload a single file`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Electron main bundle verification failed:");
  for (const violation of violations) {
    console.error(`  ${violation.file}: ${violation.label}`);
  }
  process.exit(1);
}

console.log(
  `main bundle boundary: OK (${javascriptFiles.length} files, no external bundled-dependency imports; ${preloadFiles.length} single-file preloads)`,
);
