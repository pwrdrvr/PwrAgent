import { readFileSync } from "node:fs";
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
