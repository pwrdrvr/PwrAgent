// Run from the repository root on a base that still has packages/shared/src/index.ts.
// Apply the hand-written mock and dynamic-import changes before running this script.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const packageName = "@pwragent/shared";
const sharedSource = path.resolve("packages/shared/src");
const barrelPath = path.join(sharedSource, "index.ts");
const project = ts.createProgram([barrelPath], {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noLib: true,
  types: [],
});
const checker = project.getTypeChecker();
const barrel = project.getSourceFile(barrelPath);
if (!barrel) throw new Error("Run the migration before deleting the shared index.");

const unalias = (symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
const exports = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(barrel))
  .map((symbol) => [symbol.name, unalias(symbol)]));

function definingModule(name) {
  const symbol = exports.get(name);
  const files = new Set(symbol?.declarations?.map((declaration) => declaration.getSourceFile()));
  if (files.size !== 1) throw new Error(`Expected one defining file for ${name}`);
  const [file] = files;
  const relative = path.relative(sharedSource, file.fileName);
  if (relative.startsWith("..") || path.isAbsolute(relative) || file === barrel) {
    throw new Error(`Definition of ${name} is outside the shared modules`);
  }
  const publicExports = checker.getExportsOfModule(checker.getSymbolAtLocation(file));
  const binding = publicExports.find((entry) => entry.name === name && unalias(entry) === symbol)
    ?? publicExports.find((entry) => entry.name === symbol.name && unalias(entry) === symbol);
  if (!binding) throw new Error(`No direct export for ${name} in ${relative}`);
  return { file: file.fileName, name: binding.name };
}

function specifierFor(source, definition, isRelative) {
  if (isRelative) {
    const relative = path.relative(path.dirname(source.fileName), definition.file).split(path.sep).join("/");
    return (relative.startsWith(".") ? relative : `./${relative}`).replace(/\.ts$/, "");
  }
  const module = path.relative(sharedSource, definition.file).split(path.sep).join("/").replace(/\.ts$/, "");
  return `${packageName}/${module}`;
}

function rewrite(file, contents) {
  const source = ts.createSourceFile(path.resolve(file), contents, ts.ScriptTarget.Latest, true);
  const edits = [];
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const replace = (node, text) => edits.push([node.getStart(source), node.getEnd(), text]);
  function targetsBarrel(literal) {
    if (!literal || !ts.isStringLiteralLike(literal)) return false;
    if (literal.text === packageName) return true;
    if (!literal.text.startsWith(".")) return false;
    const target = path.resolve(path.dirname(source.fileName), literal.text);
    return target === sharedSource || target.replace(/\.(?:js|ts)$/, "") === barrelPath.slice(0, -3);
  }

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && targetsBarrel(node.moduleSpecifier)) {
      const isImport = ts.isImportDeclaration(node);
      const clause = isImport ? node.importClause : node;
      const bindings = isImport ? clause?.namedBindings : node.exportClause;
      if (!bindings || !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
        || (isImport && clause.name) || node.attributes) {
        throw new Error("Expected a named import or re-export");
      }
      if (bindings.elements.length === 0) {
        // The shared package declares sideEffects: false.
        const start = node.getStart(source);
        const lineStart = contents.lastIndexOf("\n", start - 1) + 1;
        const lineEnd = contents.indexOf(newline, node.getEnd());
        if (lineEnd !== -1 && !contents.slice(lineStart, start).trim()
          && !contents.slice(node.getEnd(), lineEnd).trim()) {
          edits.push([lineStart, lineEnd + newline.length, ""]);
        } else {
          replace(node, "");
        }
        return;
      }
      const groups = new Map();
      for (const element of bindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        const definition = definingModule(name);
        const specifier = specifierFor(source, definition, node.moduleSpecifier.text !== packageName);
        const items = groups.get(specifier) ?? [];
        const binding = element.getText(source);
        const text = definition.name === name
          ? binding
          : `${element.isTypeOnly ? "type " : ""}${definition.name} as ${element.name.getText(source)}`;
        items.push({ text, leading: element.getFullText(source).slice(0, -binding.length).trim() });
        groups.set(specifier, items);
      }
      const start = node.getStart(source);
      const lineStart = contents.lastIndexOf("\n", start - 1) + 1;
      const indent = contents.slice(lineStart, start).match(/^\s*/)[0];
      const keyword = isImport ? "import" : "export";
      const prefix = `${keyword}${clause.isTypeOnly ? " type" : ""}`;
      const suffix = bindings.elements.hasTrailingComma
        ? source.text.slice(bindings.elements.end, bindings.getEnd() - 1).trim()
        : "";
      if (suffix) throw new Error("Preserve trailing import-list trivia by hand");
      const statements = [...groups].map(([specifier, items]) => {
        const individual = items.map(({ text }) => text).join(", ");
        const line = `${prefix} { ${individual} } from "${specifier}";`;
        if (line.length + indent.length <= 110 && items.every(({ leading }) => !leading)) return line;
        const entries = items.flatMap(({ text, leading }) => [
          ...leading.split(/\r?\n/).filter(Boolean).map((comment) => `${indent}  ${comment.trim()}`),
          `${indent}  ${text},`,
        ]);
        return [`${prefix} {`, ...entries, `${indent}} from "${specifier}";`].join(newline);
      });
      replace(node, statements.join(newline + indent));
      return;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && targetsBarrel(node.argument.literal)) {
      let qualifier = node.qualifier;
      while (qualifier && ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
      if (!qualifier) throw new Error("Migrate an import of the module namespace by hand");
      const definition = definingModule(qualifier.text);
      replace(node.argument.literal, JSON.stringify(specifierFor(source, definition, node.argument.literal.text !== packageName)));
      if (definition.name !== qualifier.text) replace(qualifier, definition.name);
    }
    if (ts.isCallExpression(node) && node.arguments[0]
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.arguments[0].text === packageName)
      && targetsBarrel(node.arguments[0])) {
      throw new Error("Migrate the dynamic import or mock by hand");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (edits.length === 0) return contents;
  for (const [start, end, text] of edits.sort(([left], [right]) => right - left)) {
    contents = contents.slice(0, start) + text + contents.slice(end);
  }
  return contents;
}

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0");
const changes = new Map();
const errors = [];
for (const file of files) {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) || path.resolve(file) === barrelPath) continue;
  const contents = readFileSync(file, "utf8");
  if (!contents.includes(packageName) && !contents.includes("index") && !file.startsWith("packages/shared/")) continue;
  try {
    const rewritten = rewrite(file, contents);
    if (rewritten !== contents) changes.set(file, rewritten);
  } catch (error) {
    errors.push(`${file}: ${error.message}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  for (const [file, contents] of changes) writeFileSync(file, contents);
  console.log(`Rewrote ${changes.size} files.`);
}
