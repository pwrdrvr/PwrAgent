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
const FC_RUNNER_METHODS = new Set(["assert", "check"]);

const DIRECTIVE_COMMENT_PATTERN = /^(?:eslint|oxlint|@ts-)/i;
const DYNAMIC_BINDING = Object.freeze({ kind: "dynamic" });

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

function unwrapExpression(node) {
  let current = node;
  while (
    current
    && (current.type === "ParenthesizedExpression"
      || current.type === "TSAsExpression"
      || current.type === "TSSatisfiesExpression"
      || current.type === "TSNonNullExpression"
      || current.type === "TSTypeAssertion")
  ) {
    current = current.expression;
  }
  return current;
}

function collectPatternIdentifiers(pattern, names = []) {
  if (!pattern || typeof pattern !== "object") return names;
  if (pattern.type === "Identifier") {
    names.push(pattern.name);
  } else if (pattern.type === "AssignmentPattern") {
    collectPatternIdentifiers(pattern.left, names);
  } else if (pattern.type === "RestElement") {
    collectPatternIdentifiers(pattern.argument, names);
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements ?? []) {
      collectPatternIdentifiers(element, names);
    }
  } else if (pattern.type === "ObjectPattern") {
    for (const prop of pattern.properties ?? []) {
      if (prop?.type === "RestElement") collectPatternIdentifiers(prop.argument, names);
      else if (prop?.type === "Property") collectPatternIdentifiers(prop.value, names);
    }
  }
  return names;
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
  const unwrapped = unwrapExpression(node);
  return unwrapped?.type === "Literal" && typeof unwrapped.value === "string";
}

function getStringLiteralValue(node) {
  const unwrapped = unwrapExpression(node);
  return unwrapped?.type === "Literal" && typeof unwrapped.value === "string"
    ? unwrapped.value
    : null;
}

function isGitCommandArg(argNode, callName) {
  const unwrapped = unwrapExpression(argNode);
  if (!unwrapped) return false;
  if (unwrapped.type === "Literal" && typeof unwrapped.value === "string") {
    const text = unwrapped.value.trim();
    if (text === "git" || /(?:^|[\\/])git(?:\.exe)?$/i.test(text)) return true;
    if ((callName === "exec" || callName === "execSync") && /^git(?:\.exe)?\s/i.test(text)) {
      return true;
    }
  }
  if (unwrapped.type === "TemplateLiteral" && unwrapped.quasis?.length > 0) {
    const head = unwrapped.quasis[0]?.value?.raw ?? "";
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
      // block or followed by a directive comment) with no code tokens and no
      // blank line in raw source between it and the target.
      if (comment.end <= target.start) {
        const between = source.slice(comment.end, target.start);
        const nonComment = between
          .replace(/\/\/[^\r\n]*/g, "")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        if (/^\s*$/.test(nonComment) && !/\r?\n[ \t]*\r?\n/.test(between)) {
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
    && !source.includes("fc.check")
    && !source.includes("configureGlobal")
  ) {
    return { heavyFixtures: [], violations: [] };
  }

  const parsed = parseSync(filename, source);
  const { program, comments } = parsed;
  const lineStarts = computeLineStarts(source);

  // 1. Collect vi.mock / vi.doMock mocked module specifiers so mocked
  //    child_process, dugite, or StateDb modules are not mistaken for real ones.
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
      mockedModules.add(getStringLiteralValue(node.arguments[0]));
    }
  });

  const childProcessMocked =
    mockedModules.has("node:child_process") || mockedModules.has("child_process");

  // 2. Collect fast-check bindings, mocked local bindings, child_process
  //    bindings, and heavy fixture signals from imports.
  const heavyFixtures = new Set();
  const fcNamespaces = new Set(["fc"]);
  const fcRunnerFns = new Set();
  const fcConfigureGlobalFns = new Set();
  const testingLibraryNamespaces = new Set();
  const mockedLocalNames = new Set();
  const childProcessNamespaces = new Set();
  const childProcessCallLocalNames = new Map();

  for (const stmt of program.body ?? []) {
    if (stmt.type !== "ImportDeclaration" || stmt.importKind === "type") continue;
    const mod = stmt.source.value;
    const isChildProcessMod = mod === "node:child_process" || mod === "child_process";
    const isModMocked = mockedModules.has(mod) || (isChildProcessMod && childProcessMocked);

    if (isModMocked) {
      for (const spec of stmt.specifiers ?? []) {
        if (spec.importKind === "type") continue;
        if (spec.local?.name) mockedLocalNames.add(spec.local.name);
      }
    }

    if (mod === "fast-check") {
      for (const spec of stmt.specifiers ?? []) {
        if (spec.importKind === "type") continue;
        if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
          fcNamespaces.add(spec.local.name);
        } else if (spec.type === "ImportSpecifier") {
          if (FC_RUNNER_METHODS.has(spec.imported?.name)) fcRunnerFns.add(spec.local.name);
          if (spec.imported?.name === "configureGlobal") fcConfigureGlobalFns.add(spec.local.name);
        }
      }
    }

    if (isChildProcessMod && !isModMocked) {
      heavyFixtures.add("child_process");
      for (const spec of stmt.specifiers ?? []) {
        if (spec.importKind === "type") continue;
        if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
          childProcessNamespaces.add(spec.local.name);
        } else if (
          spec.type === "ImportSpecifier"
          && CHILD_PROCESS_CALL_NAMES.has(spec.imported?.name)
        ) {
          childProcessCallLocalNames.set(spec.local.name, spec.imported.name);
        }
      }
    }
    if (mod === "dugite" && !isModMocked) {
      heavyFixtures.add("git");
    }
    if (mod === "better-sqlite3" && !isModMocked) {
      heavyFixtures.add("state-db");
    }
    if (GIT_FIXTURE_PATTERN.test(mod) && !isModMocked) {
      heavyFixtures.add("git");
    }
    if (STATE_DB_HARNESS_PATTERN.test(mod) && !isModMocked) {
      heavyFixtures.add("state-db");
    }
    if (CHILD_PROCESS_FIXTURE_PATTERN.test(mod) && !isModMocked) {
      heavyFixtures.add("child_process");
    }

    const isTl = isTestingLibraryModule(mod) && !isModMocked;
    for (const spec of stmt.specifiers ?? []) {
      if (spec.importKind === "type") continue;
      const importedName =
        spec.type === "ImportSpecifier"
          ? spec.imported?.name
          : spec.type === "ImportDefaultSpecifier"
            ? "default"
            : "*";
      if (importedName && STATE_DB_IMPORT_NAMES.has(importedName) && !isModMocked) {
        heavyFixtures.add("state-db");
      }
      if (importedName && GIT_IMPORT_NAMES.has(importedName) && !isModMocked) {
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

  // 3. Collect CommonJS require(...) bindings, promisified child_process aliases,
  //    and heavy call sites (respecting mocked modules and child_process receivers).
  walkAst(program, (node) => {
    if (node.type === "VariableDeclarator" && node.init) {
      const init = unwrapExpression(node.init);
      if (
        init?.type === "CallExpression"
        && init.callee?.type === "Identifier"
        && init.callee.name === "require"
        && isStringLiteral(init.arguments?.[0])
      ) {
        const mod = getStringLiteralValue(init.arguments[0]);
        const isChildProcessMod = mod === "node:child_process" || mod === "child_process";
        const isModMocked = mockedModules.has(mod) || (isChildProcessMod && childProcessMocked);

        if (isModMocked) {
          for (const name of collectPatternIdentifiers(node.id)) {
            mockedLocalNames.add(name);
          }
          return;
        }

        if (mod === "fast-check") {
          if (node.id?.type === "Identifier") {
            fcNamespaces.add(node.id.name);
          } else if (node.id?.type === "ObjectPattern") {
            for (const prop of node.id.properties ?? []) {
              if (prop.type !== "Property" || prop.value?.type !== "Identifier") continue;
              const key = getPropertyKeyName(prop);
              if (key && FC_RUNNER_METHODS.has(key)) fcRunnerFns.add(prop.value.name);
              if (key === "configureGlobal") fcConfigureGlobalFns.add(prop.value.name);
            }
          }
        }
        if (isChildProcessMod) {
          heavyFixtures.add("child_process");
          if (node.id?.type === "Identifier") {
            childProcessNamespaces.add(node.id.name);
          } else if (node.id?.type === "ObjectPattern") {
            for (const prop of node.id.properties ?? []) {
              if (prop.type !== "Property" || prop.value?.type !== "Identifier") continue;
              const key = getPropertyKeyName(prop);
              if (key && CHILD_PROCESS_CALL_NAMES.has(key)) {
                childProcessCallLocalNames.set(prop.value.name, key);
              }
            }
          }
        }
        if (mod === "dugite") heavyFixtures.add("git");
        if (mod === "better-sqlite3") heavyFixtures.add("state-db");
        if (isTestingLibraryModule(mod)) {
          if (node.id?.type === "Identifier") {
            testingLibraryNamespaces.add(node.id.name);
          } else if (node.id?.type === "ObjectPattern") {
            for (const prop of node.id.properties ?? []) {
              const key = getPropertyKeyName(prop);
              if (key && RENDER_NAMES.has(key)) heavyFixtures.add("testing-library");
            }
          }
        }
        return;
      }

      // Track promisify(execFile) / promisify(cp.execFile) wrappers.
      if (
        node.id?.type === "Identifier"
        && init?.type === "CallExpression"
        && init.callee?.type === "Identifier"
        && init.callee.name === "promisify"
      ) {
        const target = unwrapExpression(init.arguments?.[0]);
        if (target?.type === "Identifier" && childProcessCallLocalNames.has(target.name)) {
          childProcessCallLocalNames.set(node.id.name, childProcessCallLocalNames.get(target.name));
        } else if (
          target?.type === "MemberExpression"
          && target.object?.type === "Identifier"
          && childProcessNamespaces.has(target.object.name)
          && target.property?.type === "Identifier"
          && CHILD_PROCESS_CALL_NAMES.has(target.property.name)
        ) {
          childProcessCallLocalNames.set(node.id.name, target.property.name);
        }
      }
    }
  });

  walkAst(program, (node) => {
    if (
      node.type === "NewExpression"
      && node.callee?.type === "Identifier"
      && node.callee.name === "StateDb"
      && !mockedLocalNames.has("StateDb")
    ) {
      heavyFixtures.add("state-db");
    }

    if (node.type === "CallExpression") {
      const callee = unwrapExpression(node.callee);
      if (
        callee?.type === "MemberExpression"
        && callee.object?.type === "Identifier"
        && callee.property?.type === "Identifier"
      ) {
        const objName = callee.object.name;
        const propName = callee.property.name;
        if (!mockedLocalNames.has(objName)) {
          if (objName === "StateDb" && propName === "open") {
            heavyFixtures.add("state-db");
          }
          if (objName === "GitProcess" && propName === "exec") {
            heavyFixtures.add("git");
          }
          if (testingLibraryNamespaces.has(objName) && RENDER_NAMES.has(propName)) {
            heavyFixtures.add("testing-library");
          }
          if (
            childProcessNamespaces.has(objName)
            && CHILD_PROCESS_CALL_NAMES.has(propName)
            && isGitCommandArg(node.arguments?.[0], propName)
          ) {
            heavyFixtures.add("git");
          }
          if (STATE_DB_CALL_NAMES.has(propName)) heavyFixtures.add("state-db");
          if (GIT_CALL_NAMES.has(propName)) heavyFixtures.add("git");
        }
      } else if (callee?.type === "Identifier" && !mockedLocalNames.has(callee.name)) {
        const callName = callee.name;
        if (STATE_DB_CALL_NAMES.has(callName)) heavyFixtures.add("state-db");
        if (GIT_CALL_NAMES.has(callName)) heavyFixtures.add("git");
        const childCallKind = childProcessCallLocalNames.get(callName);
        if (childCallKind && isGitCommandArg(node.arguments?.[0], childCallKind)) {
          heavyFixtures.add("git");
        }
      }
    }
  });

  // 4. Single lexically scoped AST traversal to resolve const numbers/objects
  //    and inspect every fc.assert(...), fc.check(...), and fc.configureGlobal(...) call.
  const sortedHeavyFixtures = [...heavyFixtures].sort();
  const violations = [];
  const scopeStack = [];

  function lookupBinding(name) {
    for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
      if (scopeStack[index].has(name)) return scopeStack[index].get(name);
    }
    return null;
  }

  function evaluateStaticNumber(node) {
    const unwrapped = unwrapExpression(node);
    if (!unwrapped) return null;
    if (unwrapped.type === "Literal" && typeof unwrapped.value === "number" && Number.isFinite(unwrapped.value)) {
      return unwrapped.value;
    }
    if (unwrapped.type === "Identifier") {
      const binding = lookupBinding(unwrapped.name);
      return binding?.kind === "number" ? binding.value : null;
    }
    if (unwrapped.type === "UnaryExpression" && (unwrapped.operator === "+" || unwrapped.operator === "-")) {
      const inner = evaluateStaticNumber(unwrapped.argument);
      return inner === null ? null : (unwrapped.operator === "-" ? -inner : inner);
    }
    if (unwrapped.type === "BinaryExpression") {
      const left = evaluateStaticNumber(unwrapped.left);
      const right = evaluateStaticNumber(unwrapped.right);
      if (left === null || right === null) return null;
      if (unwrapped.operator === "+") return left + right;
      if (unwrapped.operator === "-") return left - right;
      if (unwrapped.operator === "*") return left * right;
      if (unwrapped.operator === "/" && right !== 0) return left / right;
      return null;
    }
    if (unwrapped.type === "ConditionalExpression") {
      const cons = evaluateStaticNumber(unwrapped.consequent);
      const alt = evaluateStaticNumber(unwrapped.alternate);
      if (cons !== null && alt !== null) return Math.max(cons, alt);
      return null;
    }
    return null;
  }

  function registerVariableDeclaration(varDecl, scope) {
    const isConst = varDecl.kind === "const";
    for (const decl of varDecl.declarations ?? []) {
      if (isConst && decl.id?.type === "Identifier" && decl.init) {
        const unwrappedInit = unwrapExpression(decl.init);
        const num = evaluateStaticNumber(unwrappedInit);
        if (num !== null) {
          scope.set(decl.id.name, { kind: "number", value: num, declNode: varDecl });
        } else if (unwrappedInit?.type === "ObjectExpression") {
          scope.set(decl.id.name, { kind: "object", objectNode: unwrappedInit, declNode: varDecl });
        } else {
          scope.set(decl.id.name, DYNAMIC_BINDING);
        }
      } else {
        for (const name of collectPatternIdentifiers(decl.id)) {
          scope.set(name, DYNAMIC_BINDING);
        }
      }
    }
  }

  function prebindStatements(statements, scope) {
    for (const stmt of statements ?? []) {
      if (!stmt) continue;
      if (stmt.type === "VariableDeclaration") {
        registerVariableDeclaration(stmt, scope);
      } else if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
        if (stmt.declaration.type === "VariableDeclaration") {
          registerVariableDeclaration(stmt.declaration, scope);
        } else if (stmt.declaration.id?.type === "Identifier") {
          scope.set(stmt.declaration.id.name, DYNAMIC_BINDING);
        }
      } else if (
        (stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration")
        && stmt.id?.type === "Identifier"
      ) {
        scope.set(stmt.id.name, DYNAMIC_BINDING);
      }
    }
  }

  function extractNumRunsFromObject(objectNode, inheritedDeclNode = null, seen = new Set()) {
    if (!objectNode || seen.has(objectNode)) {
      return { kind: "dynamic", value: null, numRunsProp: null, declNode: inheritedDeclNode };
    }
    seen.add(objectNode);

    let result = { kind: "missing", value: null, numRunsProp: null, declNode: inheritedDeclNode };
    for (const prop of objectNode.properties ?? []) {
      if (prop.type === "SpreadElement") {
        const spreadArg = unwrapExpression(prop.argument);
        if (spreadArg?.type === "ObjectExpression") {
          const spreadResult = extractNumRunsFromObject(spreadArg, inheritedDeclNode, seen);
          if (spreadResult.kind !== "missing") result = spreadResult;
        } else if (spreadArg?.type === "Identifier") {
          const binding = lookupBinding(spreadArg.name);
          if (binding?.kind === "object") {
            const spreadResult = extractNumRunsFromObject(binding.objectNode, binding.declNode, seen);
            if (spreadResult.kind !== "missing") result = spreadResult;
          } else {
            result = { kind: "dynamic", value: null, numRunsProp: prop, declNode: inheritedDeclNode };
          }
        } else {
          result = { kind: "dynamic", value: null, numRunsProp: prop, declNode: inheritedDeclNode };
        }
        continue;
      }
      if (prop.type === "Property" && getPropertyKeyName(prop) === "numRuns") {
        const unwrappedVal = unwrapExpression(prop.value);
        const val = evaluateStaticNumber(unwrappedVal);
        let valueDecl = inheritedDeclNode;
        if (unwrappedVal?.type === "Identifier") {
          const binding = lookupBinding(unwrappedVal.name);
          if (binding?.kind === "number") valueDecl = binding.declNode;
        }
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
    const unwrappedArg = unwrapExpression(optionsArg);
    if (unwrappedArg?.type === "ObjectExpression") {
      const extracted = extractNumRunsFromObject(unwrappedArg);
      if (extracted.kind === "missing") {
        if (isConfigureGlobal) return extracted;
        return { kind: "default", value: DEFAULT_NUM_RUNS, numRunsProp: null, declNode: null };
      }
      return extracted;
    }
    if (unwrappedArg?.type === "Identifier") {
      const binding = lookupBinding(unwrappedArg.name);
      if (binding?.kind === "object") {
        const extracted = extractNumRunsFromObject(binding.objectNode, binding.declNode);
        if (extracted.kind === "missing") {
          if (isConfigureGlobal) return extracted;
          return { kind: "default", value: DEFAULT_NUM_RUNS, numRunsProp: null, declNode: binding.declNode };
        }
        return extracted;
      }
    }
    return { kind: "dynamic", value: null, numRunsProp: null, declNode: null };
  }

  function inspectCallExpression(node) {
    const callee = unwrapExpression(node.callee);
    const isFcRunner =
      (callee?.type === "MemberExpression"
        && callee.object?.type === "Identifier"
        && fcNamespaces.has(callee.object.name)
        && callee.property?.type === "Identifier"
        && FC_RUNNER_METHODS.has(callee.property.name))
      || (callee?.type === "Identifier" && fcRunnerFns.has(callee.name));

    const isFcConfigureGlobal =
      (callee?.type === "MemberExpression"
        && callee.object?.type === "Identifier"
        && fcNamespaces.has(callee.object.name)
        && callee.property?.type === "Identifier"
        && callee.property.name === "configureGlobal")
      || (callee?.type === "Identifier" && fcConfigureGlobalFns.has(callee.name));

    if (!isFcRunner && !isFcConfigureGlobal) return;

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
      const unwrappedOptions = optionsArg ? unwrapExpression(optionsArg) : null;
      const commentTargets = [
        info.numRunsProp,
        optionsArg,
        unwrappedOptions !== optionsArg ? unwrappedOptions : null,
        info.declNode,
      ].filter(Boolean);
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
  }

  function visitChildren(node) {
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "type") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) visitScoped(item);
      } else if (value && typeof value === "object" && typeof value.type === "string") {
        visitScoped(value);
      }
    }
  }

  function visitScoped(node) {
    if (!node || typeof node !== "object") return;

    if (node.type === "Program" || node.type === "BlockStatement") {
      const scope = new Map();
      scopeStack.push(scope);
      prebindStatements(node.body, scope);
      for (const stmt of node.body ?? []) visitScoped(stmt);
      scopeStack.pop();
      return;
    }

    if (
      node.type === "FunctionDeclaration"
      || node.type === "FunctionExpression"
      || node.type === "ArrowFunctionExpression"
    ) {
      const scope = new Map();
      if (node.type === "FunctionExpression" && node.id?.type === "Identifier") {
        scope.set(node.id.name, DYNAMIC_BINDING);
      }
      for (const param of node.params ?? []) {
        for (const name of collectPatternIdentifiers(param)) {
          scope.set(name, DYNAMIC_BINDING);
        }
      }
      scopeStack.push(scope);
      for (const param of node.params ?? []) visitScoped(param);
      visitScoped(node.body);
      scopeStack.pop();
      return;
    }

    if (node.type === "CatchClause") {
      const scope = new Map();
      for (const name of collectPatternIdentifiers(node.param)) {
        scope.set(name, DYNAMIC_BINDING);
      }
      scopeStack.push(scope);
      if (node.param) visitScoped(node.param);
      visitScoped(node.body);
      scopeStack.pop();
      return;
    }

    if (
      node.type === "ForStatement"
      || node.type === "ForInStatement"
      || node.type === "ForOfStatement"
    ) {
      const scope = new Map();
      if (node.type === "ForStatement" && node.init?.type === "VariableDeclaration") {
        registerVariableDeclaration(node.init, scope);
      } else if (
        (node.type === "ForInStatement" || node.type === "ForOfStatement")
        && node.left?.type === "VariableDeclaration"
      ) {
        registerVariableDeclaration(node.left, scope);
      }
      scopeStack.push(scope);
      visitChildren(node);
      scopeStack.pop();
      return;
    }

    if (node.type === "SwitchStatement") {
      visitScoped(node.discriminant);
      const scope = new Map();
      scopeStack.push(scope);
      for (const switchCase of node.cases ?? []) {
        prebindStatements(switchCase.consequent, scope);
      }
      for (const switchCase of node.cases ?? []) visitScoped(switchCase);
      scopeStack.pop();
      return;
    }

    if (node.type === "CallExpression") {
      inspectCallExpression(node);
    }

    visitChildren(node);
  }

  visitScoped(program);

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
    `- Tests using real git, StateDb, child_process, or @testing-library rendering must keep fc.assert/fc.check numRuns <= ${HEAVY_FIXTURE_MAX_NUM_RUNS} (never left at the default 100). Move the property onto pure in-memory code and keep 1-3 named examples on the real fixture.`,
  );
  lines.push(
    `- Any fc.assert/fc.check with numRuns > ${HIGH_NUM_RUNS_COMMENT_THRESHOLD} must have an adjacent comment on or directly above numRuns (or its options object) naming the bug that required it.`,
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
