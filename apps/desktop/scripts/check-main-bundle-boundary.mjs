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
    label: "AI SDK package marker",
    pattern: /(?:@ai-sdk\/xai|ai-sdk\/provider|ai-sdk\/ui-utils)/i,
  },
  {
    label: "AI SDK runtime symbol",
    pattern: /(?:xai\.responses|xAI Responses API|AI SDK telemetry)/,
  },
  {
    label: "xAI runtime endpoint",
    pattern: /api\.x\.ai\/v1\/responses/,
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

if (violations.length > 0) {
  console.error("Electron main bundle contains forbidden Grok runtime code:");
  for (const violation of violations) {
    console.error(`  ${violation.file}: ${violation.label}`);
  }
  process.exit(1);
}

console.log(
  `main bundle boundary: OK (${javascriptFiles.length} files, no AI SDK/xAI runtime)`,
);
