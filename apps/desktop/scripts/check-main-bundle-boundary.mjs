#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainOutputDirectory = path.resolve(desktopRoot, "out", "main");

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(filePath);
    return entry.isFile() && /\.(?:c|m)?js$/.test(entry.name) ? [filePath] : [];
  }));
  return files.flat();
}

const javascriptFiles = await listJavaScriptFiles(mainOutputDirectory);
const forbidden = [
  {
    label: "externalized ws runtime import",
    pattern: /\b(?:from\s+|import\(|require\()["'`]ws["'`]/,
  },
  {
    label: "externalized workspace bundled-dependency import",
    pattern:
      /\b(?:from\s+|import\(|require\()["'`]@pwragent\/(?:shared|messaging-interface|messaging-provider-[^/"'`]+)["'`]/,
  },
];
const violations = [];

function checkSyntax(filePath) {
  try {
    execFileSync(process.execPath, ["--check", filePath], {
      stdio: "pipe",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const reason = error.stderr?.toString().match(/^SyntaxError:.*$/m)?.[0]
      ?? error.message.split("\n")[0];
    violations.push({
      file: path.relative(desktopRoot, filePath),
      label: `invalid JavaScript: ${reason}`,
    });
  }
}

for (const filePath of javascriptFiles) {
  checkSyntax(filePath);
  const contents = await readFile(filePath, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(contents)) {
      violations.push({
        file: path.relative(desktopRoot, filePath),
        label: rule.label,
      });
    }
  }
  // Vitest accepts synthetic named exports from xterm's CommonJS packages,
  // but Node/Electron's native ESM loader does not. Check the actual bundled
  // import clauses without booting Electron or opening a desktop window.
  const terminalImports = [...contents.matchAll(
    /\bimport\s*[^;]*?\bfrom\s*["']@xterm\/(?:headless|addon-serialize)["'];?/g,
  )].map(([statement]) => statement);
  if (terminalImports.length > 0) {
    try {
      execFileSync(process.execPath, ["--input-type=module", "--eval", terminalImports.join("\n")], {
        cwd: desktopRoot,
        stdio: "pipe",
      });
    } catch (error) {
      violations.push({
        file: path.relative(desktopRoot, filePath),
        label: `terminal dependency imports rejected by native ESM: ${error.stderr?.toString().split("\n").slice(0, 4).join(" ") ?? error.message}`,
      });
    }
  }
}

// Every preload runs sandboxed, where `require` resolves only Electron's own
// modules. When two preload entries share code, Rollup splits it into
// `out/preload/chunks/`, and each entry's `require("./chunks/...")` throws at
// load. The main window then has no desktop API and the app cannot start.
const preloadOutputDirectory = path.resolve(desktopRoot, "out", "preload");
const preloadFiles = await listJavaScriptFiles(preloadOutputDirectory);
for (const filePath of preloadFiles) {
  checkSyntax(filePath);
  const contents = await readFile(filePath, "utf8");
  for (const [, specifier] of contents.matchAll(/\brequire\(["'`]([^"'`]+)["'`]\)/g)) {
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
