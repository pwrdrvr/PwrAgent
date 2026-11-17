import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";

export function sourceFiles(directory, { excludeTests = true } = {}) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || (excludeTests && ["__tests__", "fixtures"].includes(entry.name))) return [];
      return sourceFiles(file, { excludeTests });
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)
      && (!excludeTests || !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) ? [file] : [];
  }).sort();
}

// All main modules are roots, even if currently unreachable from index.ts.
// Resolve every literal first-party edge (including package exports), without
// an exemption list. Production maps add worker/generated/bundled sources.
export function discoverMainBytecodeSources(root, roots, additional = []) {
  root = realpathSync(root);
  const visited = new Set();
  const dynamic = [];
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true };
  function visit(file) {
    file = realpathSync(file);
    if (/\.d\.[cm]?ts$/.test(file)) {
      const implementation = file.replace(/\.d\.([cm]?)ts$/, ".$1js");
      if (existsSync(implementation)) visit(implementation);
      return;
    }
    if (visited.has(file) || !/\.[cm]?[jt]sx?$/.test(file) || /\.d\.[cm]?ts$/.test(file)) return;
    if (!file.startsWith(root + sep) || file.includes(sep + "node_modules" + sep)) return;
    visited.add(file);
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function add(specifier) {
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        dynamic.push({ file: relative(root, file), position: specifier?.pos ?? 0 });
        return;
      }
      const name = specifier.text;
      if (name.endsWith("?raw")) return;
      if (/\.(?:md|json|node|svg|png|css)(?:\?.*)?$/.test(name)) return;
      const found = ts.resolveModuleName(name, file, options, ts.sys).resolvedModule;
      if (found) visit(found.resolvedFileName);
      else if (!name.startsWith("node:") && !builtinModules.includes(name)) throw new Error(`Cannot resolve module import ${name} in ${file}`);
    }
    const localRequireFunctions = [];
    const nodes = [ast];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "require"
        && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) localRequireFunctions.push(node.parent.parent.parent);
      if (ts.isFunctionDeclaration(node) && node.name?.text === "require") localRequireFunctions.push(node.parent);
      ts.forEachChild(node, (child) => { nodes.push(child); });
    }
    function shadowedRequire(node) {
      return localRequireFunctions.some((scope) => scope.pos <= node.pos && node.end <= scope.end);
    }
    for (const node of nodes) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !node.isTypeOnly && !node.importClause?.isTypeOnly && node.moduleSpecifier) add(node.moduleSpecifier);
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require" && !shadowedRequire(node)))) add(node.arguments[0]);
    }
  }
  [...roots, ...additional.filter(existsSync)].forEach(visit);
  return { sources: [...visited].map((file) => relative(root, file).replaceAll("\\", "/")).sort(), dynamic };
}
