import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const maxBarrelSources = 10;
const sharedPackage = "@pwragent/shared";
const sharedDirectory = "packages/shared/src";
const barrelExemptions = new Set([
  // The renderer's icon modules are leaf components. Keep their local catalog
  // independent of the shared package migration.
  "apps/desktop/src/renderer/src/icons/index.ts",
]);
const mockMethods = new Set(["mock", "doMock", "unmock", "doUnmock", "importMock", "importActual"]);

function isModuleLoader(expression) {
  return expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(expression) && expression.text === "require")
    || (ts.isPropertyAccessExpression(expression) && (
      (expression.expression.getText() === "require" && expression.name.text === "resolve")
      || (["vi", "vitest", "jest"].includes(expression.expression.getText()) && mockMethods.has(expression.name.text))
      || (expression.expression.getText() === "import.meta" && expression.name.text === "resolve")
    ));
}

function isSharedRoot(file, specifier) {
  if (specifier === sharedPackage || specifier === `${sharedPackage}/index`) return true;
  if (!specifier.startsWith(".")) return false;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\/$/, "");
  return target === sharedDirectory || /^packages\/shared\/src\/index(?:\.[cm]?[jt]s)?$/.test(target);
}

// Count distinct modules so a small facade may re-export many names from one
// implementation. Recognize both direct re-exports and imported local aliases.
function barrelSources(statements) {
  const imported = new Map();
  const reExported = new Set();
  for (const node of statements) {
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const { name, namedBindings } = node.importClause;
      const specifier = node.moduleSpecifier.text;
      if (name) imported.set(name.text, specifier);
      if (namedBindings && ts.isNamespaceImport(namedBindings)) imported.set(namedBindings.name.text, specifier);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) imported.set(element.name.text, specifier);
      }
    } else if (!ts.isExportDeclaration(node) && !ts.isExportAssignment(node) && !ts.isEmptyStatement(node)) {
      return 0;
    }
  }
  for (const node of statements) {
    if (ts.isExportAssignment(node)) {
      if (node.isExportEquals || !ts.isIdentifier(node.expression)) return 0;
      const specifier = imported.get(node.expression.text);
      if (!specifier) return 0;
      reExported.add(specifier);
      continue;
    }
    if (!ts.isExportDeclaration(node)) continue;
    if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      reExported.add(node.moduleSpecifier.text);
    } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        const specifier = imported.get((element.propertyName ?? element.name).text);
        if (specifier) reExported.add(specifier);
      }
    }
  }
  return reExported.size;
}

export function importBoundaryViolations(file, contents) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const violations = [];
  if (!barrelExemptions.has(file) && barrelSources(source.statements) > maxBarrelSources) {
    violations.push(`${file}: pure re-export file exceeds ${maxBarrelSources} source modules. Import from the defining modules.`);
  }

  function check(literal) {
    if (!literal || !ts.isStringLiteralLike(literal) || !isSharedRoot(file, literal.text)) return;
    const { line, character } = source.getLineAndCharacterOfPosition(literal.getStart(source));
    violations.push(`${file}:${line + 1}:${character + 1}: ${literal.text} is a removed import path. Import from @pwragent/shared/<module>.`);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      check(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      check(node.argument.literal);
    } else if (ts.isExternalModuleReference(node)) {
      check(node.expression);
    } else if (ts.isCallExpression(node) && isModuleLoader(node.expression)) {
      check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

export function checkImportBoundaries(root) {
  const extensions = "{ts,tsx,js,jsx,mts,cts,mjs,cjs}";
  const files = globSync([`*.${extensions}`, ...["apps", "packages", "scripts"].map((dir) => `${dir}/**/*.${extensions}`)], {
    cwd: root,
    exclude: [
      "**/node_modules", "**/dist", "**/out", "**/coverage", "**/.local",
      "apps/desktop/release-stage", "apps/desktop/release-stage-arm64",
      "packages/pwragent/runtime",
    ],
  });
  return files.sort().flatMap((file) => importBoundaryViolations(
    file.split(path.sep).join("/"),
    readFileSync(path.join(root, file), "utf8"),
  ));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkImportBoundaries(fileURLToPath(new URL("../", import.meta.url)));
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
}
