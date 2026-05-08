#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const scanRoots = [
  "apps/desktop/src/main/state",
  "apps/desktop/src/main/messaging",
];

const sqlKeywordPattern =
  /\b(SELECT\b[\s\S]*\bFROM|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\b[\s\S]*\bSET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE|PRAGMA\b)\b/i;

const allowedInterpolatedSql = new Set([
  "apps/desktop/src/main/state/messaging-store-sqlite.ts:263",
  "apps/desktop/src/main/state/migration.ts:534",
]);

const findings = [];

for (const scanRoot of scanRoots) {
  for (const filePath of listTypeScriptFiles(resolve(repoRoot, scanRoot))) {
    inspectFile(filePath);
  }
}

if (findings.length > 0) {
  console.error("Interpolated SQL template strings are not allowed.");
  console.error("Bind values with prepared-statement parameters instead.");
  console.error("");
  for (const finding of findings) {
    console.error(`- ${finding.location}: ${finding.preview}`);
  }
  process.exit(1);
}

console.log("sql template lint passed");

function listTypeScriptFiles(directory) {
  const results = [];
  for (const entry of readdirSync(directory)) {
    const entryPath = resolve(directory, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      results.push(...listTypeScriptFiles(entryPath));
    } else if (entryPath.endsWith(".ts") || entryPath.endsWith(".tsx")) {
      results.push(entryPath);
    }
  }
  return results;
}

function inspectFile(filePath) {
  const sourceText = readFileSync(filePath, "utf8");
  const relPath = relative(repoRoot, filePath);
  for (const template of findTemplateLiterals(sourceText)) {
    if (template.value.includes("${") && sqlKeywordPattern.test(template.value)) {
      const location = `${relPath}:${template.line}`;
      if (!allowedInterpolatedSql.has(location)) {
        findings.push({
          location,
          preview: compact(template.value),
        });
      }
    }
  }
}

function findTemplateLiterals(sourceText) {
  const templates = [];
  let line = 1;
  let index = 0;
  let state = "code";
  let templateStart = -1;
  let templateLine = 1;

  while (index < sourceText.length) {
    const char = sourceText[index];
    const next = sourceText[index + 1];

    if (char === "\n") {
      line += 1;
    }

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line-comment";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block-comment";
        index += 2;
        continue;
      }
      if (char === "'") {
        state = "single-string";
      } else if (char === '"') {
        state = "double-string";
      } else if (char === "`") {
        state = "template";
        templateStart = index;
        templateLine = line;
      }
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
      }
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (state === "single-string" || state === "double-string") {
      const quote = state === "single-string" ? "'" : '"';
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) {
        state = "code";
      }
      index += 1;
      continue;
    }

    if (state === "template") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        templates.push({
          line: templateLine,
          value: sourceText.slice(templateStart, index + 1),
        });
        state = "code";
      }
      index += 1;
      continue;
    }
  }

  return templates;
}

function compact(value) {
  return value.replace(/\s+/g, " ").slice(0, 160);
}
