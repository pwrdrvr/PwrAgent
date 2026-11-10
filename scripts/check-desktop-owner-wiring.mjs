#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const RULE = "desktop-shell-does-not-wire-owners";
const bindingSuffix = /(?:Handlers?|Resolvers?|Publishers?|Canonicalizers?|Readers?|Writers?|Cleaners?|Services?|Actions|Projectors?|Advisory)$/;

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
}

/** Inspect syntax, including aliases and computed/optional calls, rather than source text. */
let ownerBindings;
function ownerBindingNames() {
  if (ownerBindings) return ownerBindings;
  ownerBindings = new Set(["onEvent"]);
  const main = resolve(import.meta.dirname, "../apps/desktop/src/main");
  for (const path of filesUnder(main).filter((path) => !path.startsWith(resolve(main, "shell") + "/"))) {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    function containsFunctionType(node) {
      if (ts.isFunctionTypeNode(node) || ts.isMethodSignature(node)) return true;
      return ts.forEachChild(node, containsFunctionType) === true;
    }
    function collect(node) {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
        && node.name && ts.isIdentifier(node.name) && /^set[A-Z]/.test(node.name.text)
        && (bindingSuffix.test(node.name.text)
          || (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
            && (!node.type || node.type.kind === ts.SyntaxKind.VoidKeyword)
            && node.parameters.some(containsFunctionType)))) {
        ownerBindings.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    }
    collect(file);
  }
  return ownerBindings;
}

export function findOwnerWiring(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports = new Map();
  const aliases = new Map();
  const strings = new Map();
  const shellRoot = resolve(import.meta.dirname, "../apps/desktop/src/main/shell");
  const withinShell = (target) => {
    const path = relative(shellRoot, target);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  function memberName(expression) {
    const node = unwrap(expression);
    if (!node) return undefined;
    if (ts.isIdentifier(node)) return aliases.get(node.text) ?? imports.get(node.text)?.name ?? node.text;
    if (ts.isPropertyAccessExpression(node)) {
      if (["call", "apply", "bind"].includes(node.name.text)) return memberName(node.expression);
      return node.name.text;
    }
    if (ts.isElementAccessExpression(node)) {
      const argument = unwrap(node.argumentExpression);
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) return argument.text;
      if (argument && ts.isIdentifier(argument)) return strings.get(argument.text);
    }
    return undefined;
  }
  function collect(node) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const module = node.moduleSpecifier.text;
      for (const item of node.importClause.namedBindings.elements) {
        imports.set(item.name.text, {
          name: (item.propertyName ?? item.name).text,
          shell: module.startsWith(".") && withinShell(resolve(dirname(filename), module)),
        });
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isIdentifier(node.name)) {
        if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) strings.set(node.name.text, initializer.text);
        const target = memberName(initializer);
        if (target) aliases.set(node.name.text, target);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) aliases.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(file);
  const findings = [];
  function inspect(node) {
    if (ts.isCallExpression(node)) {
      const name = memberName(node.expression);
      const direct = unwrap(node.expression);
      const shellFunction = ts.isIdentifier(direct) && imports.get(direct.text)?.shell;
      if (!shellFunction && ownerBindingNames().has(name)) {
        const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
        findings.push({ method: name, line: line + 1, column: character + 1 });
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(file);
  return findings;
}

let resolutionOptions;
const resolvedImports = new Map();

/** Type-only imports must obey the same boundary as emitted JavaScript imports. */
export function findOwnerImports(source, filename) {
  const main = resolve(import.meta.dirname, "../apps/desktop/src/main");
  const shell = resolve(main, "shell");
  const relativeName = relative(main, filename).replaceAll("\\", "/");
  if (relativeName.startsWith("../") || isAbsolute(relativeName) || relativeName.startsWith("shell/")
    || relativeName.includes("/__tests__/") || relativeName.startsWith("__tests__/")
    || /\.test\.[cm]?tsx?$/.test(relativeName)) return [];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  function inspect(node) {
    let argument;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) argument = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) argument = node.argument.literal;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) argument = node.arguments[0];
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) argument = node.moduleReference.expression;
    if (argument && ts.isStringLiteralLike(argument)) {
      const specifier = argument.text;
      let rule;
      if (specifier === "electron" || specifier.startsWith("electron/")) rule = "desktop-electron-is-shell-only";
      else if (relativeName !== "index.ts") {
        const key = `${dirname(filename)}\0${specifier}`;
        if (!resolvedImports.has(key)) {
          resolutionOptions ??= ts.getParsedCommandLineOfConfigFile(resolve(main, "../../tsconfig.json"), {}, {
            ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {},
          })?.options ?? {};
          const target = ts.resolveModuleName(specifier, filename, resolutionOptions, ts.sys).resolvedModule?.resolvedFileName;
          resolvedImports.set(key, target ?? (specifier.startsWith(".") ? resolve(dirname(filename), specifier) : ""));
        }
        const target = resolvedImports.get(key);
        const path = target ? relative(shell, target).replaceAll("\\", "/") : "../";
        if (path === "" || (!path.startsWith("../") && !isAbsolute(path))) rule = "desktop-owner-does-not-import-shell";
      }
      if (rule) {
        const { line, character } = file.getLineAndCharacterOfPosition(argument.getStart(file));
        findings.push({ rule, module: specifier, line: line + 1, column: character + 1 });
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(file);
  return findings;
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : filesUnder(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

export function checkOwnerWiring(repoRoot) {
  const shell = resolve(repoRoot, "apps/desktop/src/main/shell");
  const files = [...filesUnder(shell), resolve(repoRoot, "apps/desktop/src/main/index.ts")];
  const calls = files.flatMap((path) => findOwnerWiring(readFileSync(path, "utf8"), path)
    .map((finding) => ({ ...finding, path: relative(repoRoot, path) })));
  const imports = filesUnder(resolve(repoRoot, "apps/desktop/src/main")).flatMap((path) =>
    findOwnerImports(readFileSync(path, "utf8"), path).map((finding) => ({ ...finding, path: relative(repoRoot, path) })));
  return [...calls, ...imports];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const findings = checkOwnerWiring(resolve(import.meta.dirname, ".."));
  for (const finding of findings) {
    const location = `${finding.path}:${finding.line}:${finding.column}`;
    console.error("module" in finding
      ? `${finding.rule}: ${location}: owner imports ${finding.module}; inject a host port.`
      : `${RULE}: ${location}: move ${finding.method} to startOwnerServices().`);
  }
  if (findings.length) process.exitCode = 1;
  else console.log(`${RULE}: passed`);
}
