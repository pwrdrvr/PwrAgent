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

runSelfTests();

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
  scanCode(0, sourceText.length);

  return templates;

  function scanCode(start, end) {
    let index = start;
    while (index < end) {
      const char = sourceText[index];
      const next = sourceText[index + 1];

      if (char === "/" && next === "/") {
        index = skipLineComment(index + 2, end);
        continue;
      }
      if (char === "/" && next === "*") {
        index = skipBlockComment(index + 2, end);
        continue;
      }
      if (char === "'" || char === '"') {
        index = skipQuotedString(index, end, char);
        continue;
      }
      if (char === "`") {
        index = readTemplate(index, end);
        continue;
      }
      index += 1;
    }
  }

  function readTemplate(start, end) {
    let index = start + 1;
    while (index < end) {
      const char = sourceText[index];
      const next = sourceText[index + 1];

      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "$" && next === "{") {
        index = readTemplateExpression(index + 2, end);
        continue;
      }
      if (char === "`") {
        templates.push({
          line: lineNumberAt(start),
          value: sourceText.slice(start, index + 1),
        });
        return index + 1;
      }
      index += 1;
    }
    return end;
  }

  function readTemplateExpression(start, end) {
    let index = start;
    let braceDepth = 1;

    while (index < end) {
      const char = sourceText[index];
      const next = sourceText[index + 1];

      if (char === "/" && next === "/") {
        index = skipLineComment(index + 2, end);
        continue;
      }
      if (char === "/" && next === "*") {
        index = skipBlockComment(index + 2, end);
        continue;
      }
      if (char === "'" || char === '"') {
        index = skipQuotedString(index, end, char);
        continue;
      }
      if (char === "`") {
        index = readTemplate(index, end);
        continue;
      }
      if (char === "{") {
        braceDepth += 1;
      } else if (char === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) {
          return index + 1;
        }
      }
      index += 1;
    }

    return end;
  }

  function skipLineComment(start, end) {
    const newline = sourceText.indexOf("\n", start);
    return newline === -1 || newline >= end ? end : newline + 1;
  }

  function skipBlockComment(start, end) {
    const close = sourceText.indexOf("*/", start);
    return close === -1 || close >= end ? end : close + 2;
  }

  function skipQuotedString(start, end, quote) {
    let index = start + 1;
    while (index < end) {
      const char = sourceText[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) {
        return index + 1;
      }
      index += 1;
    }
    return end;
  }

  function lineNumberAt(position) {
    let line = 1;
    for (let index = 0; index < position; index += 1) {
      if (sourceText[index] === "\n") {
        line += 1;
      }
    }
    return line;
  }
}

function compact(value) {
  return value.replace(/\s+/g, " ").slice(0, 160);
}

function runSelfTests() {
  const unsafeNested =
    "db.prepare(`SELECT * FROM bindings ${cond ? `WHERE binding_id = '${id}'` : \"\"}`);";
  const unsafeMatches = findTemplateLiterals(unsafeNested).filter(
    (template) =>
      template.value.includes("${") && sqlKeywordPattern.test(template.value),
  );
  if (
    !unsafeMatches.some((template) =>
      template.value.includes("WHERE binding_id"),
    )
  ) {
    throw new Error(
      "sql template lint self-test failed: nested SQL template interpolation was not detected",
    );
  }

  const nonSqlTemplate = "const message = `Inbound from ${name}`;";
  const falseMatches = findTemplateLiterals(nonSqlTemplate).filter(
    (template) =>
      template.value.includes("${") && sqlKeywordPattern.test(template.value),
  );
  if (falseMatches.length > 0) {
    throw new Error(
      "sql template lint self-test failed: non-SQL interpolation was flagged",
    );
  }
}
