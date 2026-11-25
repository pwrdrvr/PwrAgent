#!/usr/bin/env node

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const HEAVY_FIXTURE_MAX_NUM_RUNS = 5;
export const HIGH_NUM_RUNS_COMMENT_THRESHOLD = 100;
export const DEFAULT_NUM_RUNS = 100;

export const RULE_HEAVY_FIXTURE = "heavyFixture";
export const RULE_HIGH_NUM_RUNS_COMMENT = "highNumRunsWithoutComment";
export const VALID_RULES = new Set([
  RULE_HEAVY_FIXTURE,
  RULE_HIGH_NUM_RUNS_COMMENT,
]);

export const BASELINE_REL_PATH = "scripts/property-budget-baseline.json";
export const BASELINE_SCHEMA_VERSION = 1;

const TEST_FILE_PATTERNS = [
  "apps/**/*.test.{ts,tsx,js,mjs,cjs}",
  "apps/**/*.spec.{ts,tsx,js,mjs,cjs}",
  "packages/**/*.test.{ts,tsx,js,mjs,cjs}",
  "packages/**/*.spec.{ts,tsx,js,mjs,cjs}",
  "scripts/**/*.test.{ts,tsx,js,mjs,cjs}",
  "scripts/**/*.spec.{ts,tsx,js,mjs,cjs}",
  ".agents/**/*.test.{ts,tsx,js,mjs,cjs}",
];

const TEST_FILE_EXCLUDES = [
  "**/node_modules/**",
  "**/out/**",
  "**/dist/**",
  "**/.local/**",
];

const STATE_DB_IMPORT_NAMES = new Set([
  "StateDb",
  "openInMemoryStateDb",
  "createTempStateDb",
  "openFreshStateDb",
  "openStateDb",
  "createStateDb",
  "registryWithInMemoryStore",
]);

const STATE_DB_CALL_NAMES = new Set([
  "openInMemoryStateDb",
  "createTempStateDb",
  "openFreshStateDb",
  "openStateDb",
  "createStateDb",
  "registryWithInMemoryStore",
]);

const STATE_DB_HARNESS_PATTERN =
  /(?:^|\/)(?:desktop-owner-fixture|built-owner-fixture|retained-owner-fixture|token-miser-test-store|messaging-[a-z-]+-harness|private-response-harness)(?:\.[cm]?[jt]s)?$/;

const GIT_IMPORT_NAMES = new Set([
  "runIsolatedGit",
  "runIsolatedGitSync",
  "GitProcess",
]);

const GIT_CALL_NAMES = new Set([
  "runIsolatedGit",
  "runIsolatedGitSync",
  "runGit",
  "runGitSync",
  "execGit",
  "gitExec",
  "initGitRepo",
  "createGitRepo",
]);

const GIT_FIXTURE_PATTERN =
  /(?:^|\/)managed-git-fixture(?:\.[cm]?[jt]s)?$/;

const CHILD_PROCESS_FIXTURE_PATTERN =
  /(?:^|\/)outpost-daemon(?:\.[cm]?[jt]s)?$/;

const CHILD_PROCESS_CALL_NAMES = new Set([
  "execFileSync",
  "execFile",
  "spawnSync",
  "spawn",
  "execSync",
  "exec",
]);

const TESTING_LIBRARY_WRAPPER_PATTERN =
  /(?:^|\/)phase-probes(?:\.[cm]?[jt]sx?)?$/;

const RENDER_NAMES = new Set(["render", "renderHook"]);

const DIRECTIVE_COMMENT_PATTERN = /^(?:eslint|oxlint|@ts-)/i;

function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

export function listTestFiles(directory = REPO_ROOT) {
  return [...globSync(TEST_FILE_PATTERNS, {
    cwd: directory,
    exclude: TEST_FILE_EXCLUDES,
  })].map(toPosixPath).sort();
}

function walkAst(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walkAst(item, visitor);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      walkAst(value, visitor);
    }
  }
}

function computeLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function getPropertyKeyName(property) {
  if (!property || property.type !== "Property") return null;
  if (property.key?.type === "Identifier" && !property.computed) {
    return property.key.name;
  }
  if (property.key?.type === "Literal") {
    return String(property.key.value);
  }
  return null;
}

function isStringLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string";
}

function isGitCommandArg(argNode, callName) {
  if (!argNode) return false;
  if (isStringLiteral(argNode)) {
    const text = argNode.value.trim();
    if (text === "git" || /(?:^|[\\/])git(?:\.exe)?$/i.test(text)) return true;
    if ((callName === "exec" || callName === "execSync") && /^git(?:\.exe)?\s/i.test(text)) {
      return true;
    }
  }
  if (argNode.type === "TemplateLiteral" && argNode.quasis?.length > 0) {
    const head = argNode.quasis[0]?.value?.raw ?? "";
    if ((callName === "exec" || callName === "execSync") && /^\s*git(?:\.exe)?\s/i.test(head)) {
      return true;
    }
  }
  return false;
}

function isTestingLibraryModule(specifier) {
  if (specifier === "@testing-library/react") return true;
  if (specifier.startsWith("@testing-library/") && !specifier.startsWith("@testing-library/jest-dom")) {
    return true;
  }
  return TESTING_LIBRARY_WRAPPER_PATTERN.test(specifier);
}

function isMeaningfulComment(comment) {
  const text = comment.value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
  return text.length > 0 && !DIRECTIVE_COMMENT_PATTERN.test(text);
}

function hasAdjacentComment(source, comments, lineStarts, targets) {
  const validComments = comments.filter(isMeaningfulComment);
  if (validComments.length === 0) return false;

  for (const target of targets) {
    if (!target || typeof target.start !== "number" || typeof target.end !== "number") {
      continue;
    }
    const targetStartLine = lineAt(lineStarts, target.start);
    const targetEndLine = lineAt(lineStarts, target.end);

    for (const comment of validComments) {
      const commentStartLine = lineAt(lineStarts, comment.start);
      const commentEndLine = lineAt(lineStarts, comment.end);

      // Inline or trailing comment on the same line as the target.
      if (commentStartLine === targetStartLine || commentEndLine === targetEndLine) {
        return true;
      }

      // Immediately preceding comment (possibly part of a multi-line comment
      // block) with no code tokens and no blank line between it and the target.
      if (comment.end <= target.start) {
        const between = source.slice(comment.end, target.start);
        const nonComment = between
          .replace(/\/\/[^\r\n]*/g, "")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        if (/^\s*$/.test(nonComment) && !/\r?\n[ \t]*\r?\n/.test(nonComment)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Statically inspect one test file for fast-check CI budget violations.
 *
 * Returns `{ heavyFixtures, violations }`, where each violation has:
 * - `rule`: `"heavyFixture"` | `"highNumRunsWithoutComment"`
 * - `line`: 1-based line number
 * - `numRuns`: evaluated numeric value, or `null` when dynamic/unprovable
 * - `numRunsKind`: `"default"` | `"static"` | `"dynamic"`
 * - `heavyFixtures`: sorted list of detected heavy fixture categories (for `heavyFixture`)
 */
export function analyzePropertyBudgetSource(
  filename,
  source,
  { requireFastCheck = true } = {},
) {
  if (
    requireFastCheck
    && !source.includes("fast-check")
    && !source.includes("fc.assert")
    && !source.includes("configureGlobal")
  ) {
    return { heavyFixtures: [], violations: [] };
  }

  const parsed = parseSync(filename, source);
  const { program, comments } = parsed;
  const lineStarts = computeLineStarts(source);

  // 1. Collect vi.mock / vi.doMock mocked module specifiers so mocked
  //    child_process or git modules are not mistaken for real subprocesses.
  const mockedModules = new Set();
  walkAst(program, (node) => {
    if (
      node.type === "CallExpression"
      && node.callee?.type === "MemberExpression"
      && node.callee.object?.type === "Identifier"
      && node.callee.object.name === "vi"
      && node.callee.property?.type === "Identifier"
      && (node.callee.property.name === "mock" || node.callee.property.name === "doMock")
      && isStringLiteral(node.arguments?.[0])
    ) {
      mockedModules.add(node.arguments[0].value);
    }
  });

  const childProcessMocked =
    mockedModules.has("node:child_process") || mockedModules.has("child_process");

  // 2. Collect fast-check bindings and heavy fixture signals from imports.
  const heavyFixtures = new Set();
  const fcNamespaces = new Set(["fc"]);
  const fcAssertFns = new Set();
  const fcConfigureGlobalFns = new Set();
  const testingLibraryNamespaces = new Set();

  for (const stmt of program.body ?? []) {
    if (stmt.type !== "ImportDeclaration" || stmt.importKind === "type") continue;
    const mod = stmt.source.value;

    if (mod === "fast-check") {
      for (const spec of stmt.specifiers ?? []) {
        if (spec.importKind === "type") continue;
        if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
          fcNamespaces.add(spec.local.name);
        } else if (spec.type === "ImportSpecifier") {
          if (spec.imported?.name === "assert") fcAssertFns.add(spec.local.name);
          if (spec.imported?.name === "configureGlobal") fcConfigureGlobalFns.add(spec.local.name);
        }
      }
    }

    if ((mod === "node:child_process" || mod === "child_process") && !childProcessMocked) {
      heavyFixtures.add("child_process");
    }
    if (mod === "dugite" && !mockedModules.has("dugite")) {
      heavyFixtures.add("git");
    }
    if (mod === "better-sqlite3" && !mockedModules.has("better-sqlite3")) {
      heavyFixtures.add("state-db");
    }
    if (GIT_FIXTURE_PATTERN.test(mod) && !mockedModules.has(mod)) {
      heavyFixtures.add("git");
    }
    if (STATE_DB_HARNESS_PATTERN.test(mod) && !mockedModules.has(mod)) {
      heavyFixtures.add("state-db");
    }
    if (CHILD_PROCESS_FIXTURE_PATTERN.test(mod) && !mockedModules.has(mod)) {
      heavyFixtures.add("child_process");
    }

    const isTl = isTestingLibraryModule(mod) && !mockedModules.has(mod);
    for (const spec of stmt.specifiers ?? []) {
      if (spec.importKind === "type") continue;
      const importedName =
        spec.type === "ImportSpecifier"
          ? spec.imported?.name
          : spec.type === "ImportDefaultSpecifier"
            ? "default"
            : "*";
      if (importedName && STATE_DB_IMPORT_NAMES.has(importedName) && !mockedModules.has(mod)) {
        heavyFixtures.add("state-db");
      }
      if (importedName && GIT_IMPORT_NAMES.has(importedName) && !mockedModules.has(mod)) {
        heavyFixtures.add("git");
      }
      if (isTl) {
        if (importedName && RENDER_NAMES.has(importedName)) {
          heavyFixtures.add("testing-library");
        } else if (spec.type === "ImportNamespaceSpecifier") {
          testingLibraryNamespaces.add(spec.local.name);
        }
      }
    }
  }

  // 3. Collect CommonJS require(...) imports, heavy calls, and const bindings.
  const constNumbers = new Map();
  const constObjects = new Map();

  function evaluateStaticNumber(node) {
    if (!node) return null;
    if (node.type === "Literal" && typeof node.value === "number" && Number.isFinite(node.value)) {
      return node.value;
    }
    if (node.type === "Identifier" && constNumbers.has(node.name)) {
      return constNumbers.get(node.name).value;
    }
    if (node.type === "UnaryExpression" && (node.operator === "+" || node.operator === "-")) {
      const inner = evaluateStaticNumber(node.argument);
      return inner === null ? null : (node.operator === "-" ? -inner : inner);
    }
    if (node.type === "BinaryExpression") {
      const left = evaluateStaticNumber(node.left);
      const right = evaluateStaticNumber(node.right);
      if (left === null || right === null) return null;
      if (node.operator === "+") return left + right;
      if (node.operator === "-") return left - right;
      if (node.operator === "*") return left * right;
      if (node.operator === "/" && right !== 0) return left / right;
      return null;
    }
    if (node.type === "ConditionalExpression") {
      const cons = evaluateStaticNumber(node.consequent);
      const alt = evaluateStaticNumber(node.alternate);
      if (cons !== null && alt !== null) return Math.max(cons, alt);
      return null;
    }
    return null;
  }

  walkAst(program, (node) => {
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const decl of node.declarations ?? []) {
        if (!decl.init) continue;
        // Handle require("...") bindings.
        if (
          decl.init.type === "CallExpression"
          && decl.init.callee?.type === "Identifier"
          && decl.init.callee.name === "require"
          && isStringLiteral(decl.init.arguments?.[0])
        ) {
          const mod = decl.init.arguments[0].value;
          if (mod === "fast-check") {
            if (decl.id?.type === "Identifier") {
              fcNamespaces.add(decl.id.name);
            } else if (decl.id?.type === "ObjectPattern") {
              for (const prop of decl.id.properties ?? []) {
                if (prop.type !== "Property" || prop.value?.type !== "Identifier") continue;
                const key = getPropertyKeyName(prop);
                if (key === "assert") fcAssertFns.add(prop.value.name);
                if (key === "configureGlobal") fcConfigureGlobalFns.add(prop.value.name);
              }
            }
          }
          if ((mod === "node:child_process" || mod === "child_process") && !childProcessMocked) {
            heavyFixtures.add("child_process");
          }
          if (mod === "dugite" && !mockedModules.has("dugite")) {
            heavyFixtures.add("git");
          }
          if (mod === "better-sqlite3" && !mockedModules.has("better-sqlite3")) {
            heavyFixtures.add("state-db");
          }
          if (isTestingLibraryModule(mod) && !mockedModules.has(mod)) {
            if (decl.id?.type === "Identifier") {
              testingLibraryNamespaces.add(decl.id.name);
            } else if (decl.id?.type === "ObjectPattern") {
              for (const prop of decl.id.properties ?? []) {
                const key = getPropertyKeyName(prop);
                if (key && RENDER_NAMES.has(key)) heavyFixtures.add("testing-library");
              }
            }
          }
          continue;
        }

        if (decl.id?.type === "Identifier") {
          const num = evaluateStaticNumber(decl.init);
          if (num !== null) {
            constNumbers.set(decl.id.name, { value: num, declNode: node });
          } else if (decl.init.type === "ObjectExpression") {
            constObjects.set(decl.id.name, { objectNode: decl.init, declNode: node });
          }
        }
      }
    }

    if (node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "StateDb") {
      heavyFixtures.add("state-db");
    }

    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (
        callee?.type === "MemberExpression"
        && callee.object?.type === "Identifier"
        && callee.property?.type === "Identifier"
      ) {
        if (callee.object.name === "StateDb" && callee.property.name === "open") {
          heavyFixtures.add("state-db");
        }
        if (callee.object.name === "GitProcess" && callee.property.name === "exec") {
          heavyFixtures.add("git");
        }
        if (
          testingLibraryNamespaces.has(callee.object.name)
          && RENDER_NAMES.has(callee.property.name)
        ) {
          heavyFixtures.add("testing-library");
        }
      }

      const callName =
        callee?.type === "Identifier"
          ? callee.name
          : callee?.type === "MemberExpression" && callee.property?.type === "Identifier"
            ? callee.property.name
            : null;
      if (callName) {
        if (STATE_DB_CALL_NAMES.has(callName)) heavyFixtures.add("state-db");
        if (GIT_CALL_NAMES.has(callName)) heavyFixtures.add("git");
        if (
          CHILD_PROCESS_CALL_NAMES.has(callName)
          && !childProcessMocked
          && isGitCommandArg(node.arguments?.[0], callName)
        ) {
          heavyFixtures.add("git");
        }
      }
    }
  });

  function extractNumRunsFromObject(objectNode, inheritedDeclNode = null, seen = new Set()) {
    if (!objectNode || seen.has(objectNode)) {
      return { kind: "dynamic", value: null, numRunsProp: null, declNode: inheritedDeclNode };
    }
    seen.add(objectNode);

    let result = { kind: "missing", value: null, numRunsProp: null, declNode: inheritedDeclNode };
    for (const prop of objectNode.properties ?? []) {
      if (prop.type === "SpreadElement") {
        if (prop.argument?.type === "Identifier" && constObjects.has(prop.argument.name)) {
          const entry = constObjects.get(prop.argument.name);
          const spreadResult = extractNumRunsFromObject(entry.objectNode, entry.declNode, seen);
          if (spreadResult.kind !== "missing") result = spreadResult;
        } else {
          result = { kind: "dynamic", value: null, numRunsProp: prop, declNode: inheritedDeclNode };
        }
        continue;
      }
      if (prop.type === "Property" && getPropertyKeyName(prop) === "numRuns") {
        const val = evaluateStaticNumber(prop.value);
        const valueDecl =
          prop.value?.type === "Identifier" && constNumbers.has(prop.value.name)
            ? constNumbers.get(prop.value.name).declNode
            : inheritedDeclNode;
        if (val !== null) {
          result = { kind: "static", value: val, numRunsProp: prop, declNode: valueDecl };
        } else {
          result = { kind: "dynamic", value: null, numRunsProp: prop, declNode: valueDecl };
        }
      }
    }
    return result;
  }

  function inspectOptionsArg(optionsArg, isConfigureGlobal) {
    if (!optionsArg) {
      if (isConfigureGlobal) return { kind: "missing", value: null, numRunsProp: null, declNode: null };
      return { kind: "default", value: DEFAULT_NUM_RUNS, numRunsProp: null, declNode: null };
    }
    if (optionsArg.type === "ObjectExpression") {
      const extracted = extractNumRunsFromObject(optionsArg);
      if (extracted.kind === "missing") {
        if (isConfigureGlobal) return extracted;
        return { kind: "default", value: DEFAULT_NUM_RUNS, numRunsProp: null, declNode: null };
      }
      return extracted;
    }
    if (optionsArg.type === "Identifier" && constObjects.has(optionsArg.name)) {
      const entry = constObjects.get(optionsArg.name);
      const extracted = extractNumRunsFromObject(entry.objectNode, entry.declNode);
      if (extracted.kind === "missing") {
        if (isConfigureGlobal) return extracted;
        return { kind: "default", value: DEFAULT_NUM_RUNS, numRunsProp: null, declNode: entry.declNode };
      }
      return extracted;
    }
    return { kind: "dynamic", value: null, numRunsProp: null, declNode: null };
  }

  // 4. Inspect every fc.assert(...) and fc.configureGlobal(...) call.
  const sortedHeavyFixtures = [...heavyFixtures].sort();
  const violations = [];

  walkAst(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    const isFcAssert =
      (callee?.type === "MemberExpression"
        && callee.object?.type === "Identifier"
        && fcNamespaces.has(callee.object.name)
        && callee.property?.type === "Identifier"
        && callee.property.name === "assert")
      || (callee?.type === "Identifier" && fcAssertFns.has(callee.name));

    const isFcConfigureGlobal =
      (callee?.type === "MemberExpression"
        && callee.object?.type === "Identifier"
        && fcNamespaces.has(callee.object.name)
        && callee.property?.type === "Identifier"
        && callee.property.name === "configureGlobal")
      || (callee?.type === "Identifier" && fcConfigureGlobalFns.has(callee.name));

    if (!isFcAssert && !isFcConfigureGlobal) return;

    const optionsArg = isFcConfigureGlobal ? node.arguments?.[0] : node.arguments?.[1];
    const info = inspectOptionsArg(optionsArg, isFcConfigureGlobal);
    if (info.kind === "missing") return;

    const line = lineAt(lineStarts, node.start);

    if (
      sortedHeavyFixtures.length > 0
      && (info.kind === "default"
        || info.kind === "dynamic"
        || (info.kind === "static" && info.value > HEAVY_FIXTURE_MAX_NUM_RUNS))
    ) {
      violations.push({
        rule: RULE_HEAVY_FIXTURE,
        line,
        numRunsKind: info.kind,
        numRuns: info.value,
        heavyFixtures: sortedHeavyFixtures,
      });
    }

    if (info.kind === "static" && info.value > HIGH_NUM_RUNS_COMMENT_THRESHOLD) {
      const commentTargets = [info.numRunsProp, optionsArg, info.declNode].filter(Boolean);
      if (!hasAdjacentComment(source, comments, lineStarts, commentTargets)) {
        violations.push({
          rule: RULE_HIGH_NUM_RUNS_COMMENT,
          line: info.numRunsProp ? lineAt(lineStarts, info.numRunsProp.start) : line,
          numRunsKind: info.kind,
          numRuns: info.value,
          heavyFixtures: sortedHeavyFixtures,
        });
      }
    }
  });

  return { heavyFixtures: sortedHeavyFixtures, violations };
}

export function scanRepository(directory = REPO_ROOT) {
  const violationsByFile = new Map();
  const files = listTestFiles(directory);
  for (const relPath of files) {
    const source = readFileSync(resolve(directory, relPath), "utf8");
    const { violations } = analyzePropertyBudgetSource(relPath, source);
    if (violations.length > 0) {
      violationsByFile.set(relPath, violations);
    }
  }
  return { scannedFiles: files.length, violationsByFile };
}

export function validateBaselineObject(baseline) {
  const errors = [];
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    return ["Baseline must be a JSON object."];
  }
  if (baseline.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    errors.push(`Baseline schemaVersion must be ${BASELINE_SCHEMA_VERSION}.`);
  }
  if (!baseline.files || typeof baseline.files !== "object" || Array.isArray(baseline.files)) {
    errors.push("Baseline must contain a 'files' object.");
    return errors;
  }
  const keys = Object.keys(baseline.files);
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1] > keys[index]) {
      errors.push(`Baseline keys must be sorted alphabetically ('${keys[index - 1]}' > '${keys[index]}').`);
      break;
    }
  }
  for (const [file, counts] of Object.entries(baseline.files)) {
    if (file.includes("\\")) {
      errors.push(`Baseline file key '${file}' must use POSIX '/' separators.`);
    }
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
      errors.push(`Baseline entry for '${file}' must be an object.`);
      continue;
    }
    const ruleKeys = Object.keys(counts);
    if (ruleKeys.length === 0) {
      errors.push(`Baseline entry for '${file}' must not be empty.`);
    }
    for (const [rule, count] of Object.entries(counts)) {
      if (!VALID_RULES.has(rule)) {
        errors.push(`Baseline entry '${file}' has unknown rule '${rule}'.`);
      }
      if (!Number.isInteger(count) || count <= 0) {
        errors.push(`Baseline entry '${file}.${rule}' must be a positive integer.`);
      }
    }
  }
  return errors;
}

export function countViolationsByRule(violations) {
  const counts = {};
  for (const violation of violations) {
    counts[violation.rule] = (counts[violation.rule] ?? 0) + 1;
  }
  return counts;
}

export function evaluatePropertyBudgetBaseline(violationsByFile, baseline) {
  const schemaErrors = validateBaselineObject(baseline);
  if (schemaErrors.length > 0) {
    return {
      ok: false,
      schemaErrors,
      regressions: [],
      shrinkable: [],
      totals: { actual: 0, baseline: 0 },
    };
  }

  const regressions = [];
  const shrinkable = [];
  let totalActual = 0;
  let totalBaseline = 0;

  const allFiles = new Set([
    ...Object.keys(baseline.files),
    ...violationsByFile.keys(),
  ]);

  for (const file of [...allFiles].sort()) {
    const fileViolations = violationsByFile.get(file) ?? [];
    const actualCounts = countViolationsByRule(fileViolations);
    const baselineCounts = baseline.files[file] ?? {};

    for (const rule of VALID_RULES) {
      const actual = actualCounts[rule] ?? 0;
      const allowed = baselineCounts[rule] ?? 0;
      totalActual += actual;
      totalBaseline += allowed;

      if (actual > allowed) {
        regressions.push({
          file,
          rule,
          actual,
          allowed,
          violations: fileViolations.filter((item) => item.rule === rule),
        });
      } else if (actual < allowed) {
        shrinkable.push({
          file,
          rule,
          actual,
          allowed,
        });
      }
    }
  }

  return {
    ok: regressions.length === 0,
    schemaErrors: [],
    regressions,
    shrinkable,
    totals: { actual: totalActual, baseline: totalBaseline },
  };
}

/**
 * Produce a monotonically shrunk baseline from an existing baseline and the
 * current repository violations. Refuses to add new files or increase any
 * existing count.
 */
export function shrinkPropertyBudgetBaseline(baseline, violationsByFile) {
  const evaluation = evaluatePropertyBudgetBaseline(violationsByFile, baseline);
  if (!evaluation.ok) {
    return { ok: false, evaluation, nextBaseline: null };
  }

  const nextFiles = {};
  for (const file of Object.keys(baseline.files).sort()) {
    const fileViolations = violationsByFile.get(file) ?? [];
    const actualCounts = countViolationsByRule(fileViolations);
    const baselineCounts = baseline.files[file];
    const nextCounts = {};

    for (const rule of [RULE_HEAVY_FIXTURE, RULE_HIGH_NUM_RUNS_COMMENT]) {
      const allowed = baselineCounts[rule] ?? 0;
      const actual = actualCounts[rule] ?? 0;
      const next = Math.min(allowed, actual);
      if (next > 0) nextCounts[rule] = next;
    }

    if (Object.keys(nextCounts).length > 0) {
      nextFiles[file] = nextCounts;
    }
  }

  return {
    ok: true,
    evaluation,
    nextBaseline: {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      rules: {
        heavyFixtureMaxNumRuns: HEAVY_FIXTURE_MAX_NUM_RUNS,
        highNumRunsCommentThreshold: HIGH_NUM_RUNS_COMMENT_THRESHOLD,
      },
      files: nextFiles,
    },
  };
}

function formatViolationDetail(violation) {
  if (violation.rule === RULE_HEAVY_FIXTURE) {
    const runsLabel =
      violation.numRunsKind === "default"
        ? `default numRuns (${DEFAULT_NUM_RUNS})`
        : violation.numRunsKind === "dynamic"
          ? "dynamic/unbounded numRuns"
          : `numRuns: ${violation.numRuns}`;
    return `line ${violation.line}: ${runsLabel} exceeds ${HEAVY_FIXTURE_MAX_NUM_RUNS} in heavy-fixture test (${violation.heavyFixtures.join(", ")})`;
  }
  return `line ${violation.line}: numRuns: ${violation.numRuns} exceeds ${HIGH_NUM_RUNS_COMMENT_THRESHOLD} without an adjacent comment explaining which bug needs it`;
}

function formatEvaluationFailure(evaluation) {
  const lines = [];
  if (evaluation.schemaErrors.length > 0) {
    lines.push(`Invalid property budget baseline (${BASELINE_REL_PATH}):`);
    for (const error of evaluation.schemaErrors) lines.push(`- ${error}`);
    return lines.join("\n");
  }

  lines.push("Property test CI budget violation detected.");
  lines.push("");
  lines.push("RULES (docs/property-model-oracle-testing.md#what-to-check-in):");
  lines.push(
    `- Tests using real git, StateDb, child_process, or @testing-library rendering must keep fc.assert numRuns <= ${HEAVY_FIXTURE_MAX_NUM_RUNS} (never left at the default 100). Move the property onto pure in-memory code and keep 1-3 named examples on the real fixture.`,
  );
  lines.push(
    `- Any fc.assert with numRuns > ${HIGH_NUM_RUNS_COMMENT_THRESHOLD} must have an adjacent comment on or directly above numRuns (or its options object) naming the bug that required it.`,
  );
  lines.push("- Existing violations in scripts/property-budget-baseline.json may only shrink.");
  lines.push("");
  lines.push("New or increased violations:");
  for (const regression of evaluation.regressions) {
    lines.push(
      `- ${regression.file} [${regression.rule}]: ${regression.actual} found (baseline allows ${regression.allowed})`,
    );
    for (const violation of regression.violations) {
      lines.push(`    ${formatViolationDetail(violation)}`);
    }
  }
  return lines.join("\n");
}

function runCli(argv = process.argv.slice(2)) {
  const allowedArgs = new Set(["--shrink-baseline"]);
  for (const arg of argv) {
    if (!allowedArgs.has(arg)) {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  const shrinkMode = argv.includes("--shrink-baseline");
  const baselineFullPath = resolve(REPO_ROOT, BASELINE_REL_PATH);
  const baseline = JSON.parse(readFileSync(baselineFullPath, "utf8"));
  const { scannedFiles, violationsByFile } = scanRepository(REPO_ROOT);

  if (shrinkMode) {
    const result = shrinkPropertyBudgetBaseline(baseline, violationsByFile);
    if (!result.ok) {
      console.error(formatEvaluationFailure(result.evaluation));
      process.exit(1);
    }
    const shrunkCount = result.evaluation.shrinkable.reduce(
      (sum, entry) => sum + (entry.allowed - entry.actual),
      0,
    );
    writeFileSync(
      baselineFullPath,
      `${JSON.stringify(result.nextBaseline, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `Shrunk ${BASELINE_REL_PATH}: removed ${shrunkCount} resolved violation(s); ${result.evaluation.totals.actual} remaining across ${Object.keys(result.nextBaseline.files).length} file(s).`,
    );
    return;
  }

  const evaluation = evaluatePropertyBudgetBaseline(violationsByFile, baseline);
  if (!evaluation.ok) {
    console.error(formatEvaluationFailure(evaluation));
    process.exit(1);
  }

  const shrinkableCount = evaluation.shrinkable.reduce(
    (sum, entry) => sum + (entry.allowed - entry.actual),
    0,
  );
  const shrinkableFiles = new Set(evaluation.shrinkable.map((entry) => entry.file)).size;

  console.log(
    `property budget lint passed (${scannedFiles} test files scanned; ${evaluation.totals.actual} baselined violations remaining).`,
  );
  if (shrinkableCount > 0) {
    console.log(
      `Note: ${shrinkableCount} baselined violation(s) across ${shrinkableFiles} file(s) are now resolved and can be shrunk with: node scripts/lint-property-budget.mjs --shrink-baseline`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
