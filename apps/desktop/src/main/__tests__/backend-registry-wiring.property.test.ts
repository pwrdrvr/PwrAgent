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

it("keeps the composition root's module accessor out of production code", () => {
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const allowed = path.join(sourceRoot, "app-server", "backend-registry-wiring.ts");
  const callers = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !file.split(path.sep).includes("__tests__") && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(sourceRoot, file))
    .filter((file) => file !== allowed && /\bregistryModules\s*\(/.test(readFileSync(file, "utf8")));
  // Importers call the registry's facade members; only tests reach a module directly.
  expect(callers).toEqual([]);
});
