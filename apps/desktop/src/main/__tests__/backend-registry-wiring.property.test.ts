import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

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

it("keeps the composition root's module accessor out of production code", () => {
  const allowed = path.join(sourceRoot, "app-server", "backend-registry-wiring.ts");
  // Any mention counts, so an aliased import or a namespace import is caught too.
  const users = productionSources
    .filter((file) => file !== allowed && /\bregistryModules\b/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(sourceRoot, file));
  // Importers call the registry's facade members; only tests reach a module directly.
  expect(users).toEqual([]);
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
    if (ts.isPropertyAccessExpression(node) && node.name.text === "stores") {
      reads.push(node.getText(file));
    }
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
    const hostNames = new Set(constructor?.parameters
      .filter((parameter) => parameter.type?.getText(file).startsWith("RegistryHost<"))
      .map((parameter) => parameter.name.getText(file)) ?? []);
    if (constructor?.body) ts.forEachChild(constructor.body, (child) => visit(child, hostNames));
    for (const member of statement.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer) visit(member.initializer, hostNames);
    }
  }
  return reads;
}

it("lets no extracted module read its host or store ports while it is constructed", () => {
  const appServer = path.join(sourceRoot, "app-server");
  const composition = new Set(["registry-context.ts", "backend-registry.ts", "backend-registry-wiring.ts", "backend-registry-construction.ts"]);
  const modules = productionSources.filter((file) =>
    path.dirname(file) === appServer
    && !composition.has(path.basename(file))
    && /from "\.\/registry-context"/.test(readFileSync(file, "utf8")));
  expect(modules.map((file) => path.basename(file))).toContain("forge-tool-bridge.ts");
  const violations = modules.flatMap((file) => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    return constructionTimeReads(source).map((read) => `${path.basename(file)}: ${read}`);
  });
  expect(violations).toEqual([]);
});
