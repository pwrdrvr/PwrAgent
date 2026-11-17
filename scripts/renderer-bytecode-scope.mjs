import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

export { bytecodeBudget as rendererBytecodeBudget } from "./bytecode-compiler.mjs";
export const rendererBytecodeRoots = [
  ["DesktopAppShell", "App.tsx"],
  ["Sidebar", "features/navigation/Sidebar.tsx"],
  ["ThreadView", "features/thread-detail/ThreadView.tsx"],
  ["AutomationEditor", "features/automations/AutomationEditor.tsx"],
  ["Composer", "features/composer/Composer.tsx"],
  ["useComposerScheduleMenu", "features/composer/useComposerScheduleMenu.ts"],
  ["useComposerSendPreparation", "features/composer/useComposerSendPreparation.ts"],
  ["useComposerWorkspaceHandoffState", "features/composer/useComposerWorkspaceHandoffState.ts"],
];

function rendererImports(root, file) {
  const absolute = resolve(root, file);
  const ast = ts.createSourceFile(file, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
  const imports = new Set();
  function add(specifier) {
    if (!ts.isStringLiteralLike(specifier)) throw new Error(`Nonliteral module import in ${file}`);
    const name = specifier.text;
    if (!name.startsWith(".") && !name.startsWith("@renderer/")) return;
    if (/\.(?:css|svg|png|webp|woff2?)(?:\?|$)/.test(name)) return;
    const base = name.startsWith("@renderer/")
      ? resolve(root, name.slice("@renderer/".length))
      : resolve(dirname(absolute), name);
    const found = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].flatMap((extension) => [base + extension, resolve(base, "index" + extension)])]
      .find((candidate) => /\.[cm]?[jt]sx?$/.test(candidate) && existsSync(candidate));
    if (!found) throw new Error(`Cannot resolve renderer import ${name} in ${file}`);
    const path = relative(root, found).replaceAll("\\", "/");
    imports.add(path);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !node.isTypeOnly && !node.importClause?.isTypeOnly && node.moduleSpecifier) {
      add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...imports].sort();
}

// Existing independent renderer dependencies form explicit ownership boundaries.
// New imports are followed recursively, so extracting a helper cannot remove it
// from the budget. Expanding the boundary list requires a reviewable policy edit.
export function discoverRendererBytecodeSources(root, roots, boundaries) {
  const excluded = new Set(boundaries);
  for (const file of roots) {
    if (excluded.has(file)) throw new Error(`A bytecode root cannot be a boundary: ${file}`);
  }
  const visited = new Set();
  function visit(file) {
    if (visited.has(file) || excluded.has(file)) return;
    visited.add(file);
    for (const dependency of rendererImports(root, file)) visit(dependency);
  }
  roots.forEach(visit);
  return [...visited].sort();
}
