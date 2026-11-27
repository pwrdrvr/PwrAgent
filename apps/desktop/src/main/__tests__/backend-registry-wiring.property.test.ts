import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const registryPath = fileURLToPath(new URL("../app-server/backend-registry.ts", import.meta.url));

it("assembles an injected registry without constructing collaborators in its constructor", () => {
  const source = readFileSync(registryPath, "utf8");
  const file = ts.createSourceFile(registryPath, source, ts.ScriptTarget.Latest, true);
  const registry = file.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "DesktopBackendRegistry");
  const constructor = registry?.members.find(ts.isConstructorDeclaration);
  expect(constructor?.body).toBeDefined();
  const constructions: string[] = [];
  function inspect(node: ts.Node): void {
    if (ts.isNewExpression(node)) constructions.push(node.expression.getText(file));
    ts.forEachChild(node, inspect);
  }
  inspect(constructor!.body!);
  expect(constructions).toEqual([]);
  const start = file.getLineAndCharacterOfPosition(constructor!.getStart(file)).line;
  const end = file.getLineAndCharacterOfPosition(constructor!.end).line;
  expect(end - start + 1).toBeLessThan(200);
});

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const productionSources = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file) && !file.split(path.sep).includes("__tests__") && !/\.test\.tsx?$/.test(file))
  .map((file) => path.join(sourceRoot, file));

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** Identifiers in code only: comments and string literals do not count. */
function mentionsRegistryModules(file: string, source: string, createSourceFile = ts.createSourceFile): boolean {
  const name = "registryModules";
  // An identifier can spell any of its characters with a Unicode escape.
  if (!source.includes(name) && !source.includes("\\u")) return false;

  const visit = (node: ts.Node): true | undefined => {
    if (ts.isIdentifier(node) && node.text === name) return true;
    return ts.forEachChild(node, visit);
  };
  return visit(createSourceFile(file, source, ts.ScriptTarget.Latest)) === true;
}

it("keeps the composition root's module accessor out of production code", () => {
  const allowed = path.join(sourceRoot, "app-server", "backend-registry-wiring.ts");
  // Any code mention counts, so an aliased or namespace import is caught too.
  const users = productionSources
    .filter((file) => file !== allowed && mentionsRegistryModules(file, readFileSync(file, "utf8")))
    .map((file) => path.relative(sourceRoot, file));
  // Importers call the registry's facade members; only tests reach a module directly.
  expect(users).toEqual([]);
});

it("skips AST construction when a source cannot contain the module accessor identifier", () => {
  const createSourceFile = vi.fn(ts.createSourceFile);
  expect(mentionsRegistryModules("unrelated.ts", "export const unrelated = 0;", createSourceFile)).toBe(false);
  expect(createSourceFile).not.toHaveBeenCalled();
});

it.each([
  ["an aliased import", "fixture.ts", 'import { registryModules as modules } from "./wiring";', true],
  ["a namespace access", "fixture.ts", "wiring.registryModules", true],
  ["a fixed-width Unicode escape", "fixture.ts", "const \\u0072egistryModules = 0;", true],
  ["a braced Unicode escape", "fixture.ts", "wiring.registry\\u{004d}odules", true],
  ["an escaped identifier in a JSX expression", "fixture.tsx", "<span>{reg\\u0069stryModules}</span>", true],
  ["a comment", "fixture.ts", "// registryModules", false],
  ["a quoted property key", "fixture.ts", 'wiring["registryModules"]', false],
  ["a regular expression", "fixture.ts", "/registryModules/", false],
  ["a template literal", "fixture.ts", "tag(`reg\\u0069stryModules`)", false],
  ["a longer identifier", "fixture.ts", "registryModulesByRegistry", false],
  ["a private identifier", "fixture.ts", "class C { #registryModules = 0; }", false],
])("checks for the exact module accessor identifier in %s", (_description, file, source, expected) => {
  expect(mentionsRegistryModules(file, source)).toBe(expected);
});

/**
 * Reads made while a module is constructed, outside any nested function. The
 * registry's ports are bound only after every module is built, and store ports
 * must be read on each call, so a constructor or field initializer may keep
 * the context and host but never read through them.
 */
function constructionTimeReads(file: ts.SourceFile): string[] {
  const reads: string[] = [];
  const visit = (node: ts.Node, hostNames: ReadonlySet<string>): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    const stores = ts.isPropertyAccessExpression(node) && ["stores", "turnState"].includes(node.name.text)
      || ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && ["stores", "turnState"].includes(node.argumentExpression.text)
      || ts.isBindingElement(node) && ["stores", "turnState"].includes((node.propertyName ?? node.name).getText(file));
    if (stores) reads.push(node.getText(file));
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword ? callee.name.text
          : undefined;
      if (name && hostNames.has(name)) reads.push(node.getText(file));
    }
    ts.forEachChild(node, (child) => visit(child, hostNames));
  };
  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const constructor = statement.members.find(ts.isConstructorDeclaration);
    const hostParameters = constructor?.parameters
      .filter((parameter) => parameter.type?.getText(file).startsWith("RegistryHost<"))
      .map((parameter) => parameter.name.getText(file)) ?? [];
    // The host counts under its parameter name and any field it is assigned to.
    const hostNames = new Set(hostParameters);
    const collectFields = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword
        && ts.isIdentifier(node.right) && hostParameters.includes(node.right.text)) {
        hostNames.add(node.left.name.text);
      }
      ts.forEachChild(node, collectFields);
    };
    if (constructor?.body) collectFields(constructor.body);
    if (constructor?.body) ts.forEachChild(constructor.body, (child) => visit(child, hostNames));
    for (const member of statement.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer) visit(member.initializer, hostNames);
    }
  }
  return reads;
}

it("lets no extracted module read its host or store ports while it is constructed", () => {
  const composition = new Set(["registry-context.ts", "backend-registry.ts", "backend-registry-wiring.ts", "backend-registry-construction.ts"]
    .map((file) => path.join(sourceRoot, "app-server", file)));
  // Any module that imports the context, from any folder and in any import form.
  const modules = productionSources.filter((file) => {
    if (composition.has(file)) return false;
    return parse(file).statements.some((statement) =>
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && /(^|\/)registry-context(\.js)?$/.test(statement.moduleSpecifier.text));
  });
  expect(modules.map((file) => path.basename(file))).toEqual(expect.arrayContaining(["forge-tool-bridge.ts", "thread-inspection-tools.ts", "thread-mcp-connections.ts", "managed-review-service.ts", "subagent-monitor-service.ts", "thread-usage-ledger.ts", "thread-archive-coordinator.ts", "thread-workspace-service.ts", "thread-directory-service.ts", "codex-runtime-supervisor.ts"]));
  const violations = modules.flatMap((file) =>
    constructionTimeReads(parse(file)).map((read) => `${path.relative(sourceRoot, file)}: ${read}`));
  expect(violations).toEqual([]);
});
