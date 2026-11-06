import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("gives every Electron spec the automatic per-attempt diagnostics owner", async () => {
  const directory = fileURLToPath(new URL("../../../e2e/", import.meta.url));
  const files = (await readdir(directory, { recursive: true }))
    .filter((file) => file.endsWith(".spec.ts"));
  expect(files.length).toBeGreaterThan(0);
  const missingOwners: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(directory, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)
        || !ts.isStringLiteral(statement.moduleSpecifier)
        || statement.moduleSpecifier.text !== "@playwright/test") continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)
        && bindings.elements.some((binding) => (binding.propertyName ?? binding.name).text === "test")) {
        missingOwners.push(file);
      }
    }
  }
  // The shared fixture owns the attempt before launchElectronApp registers
  // pre-close snapshots. A base Playwright test has no such owner.
  expect(missingOwners.sort()).toEqual([]);
});
