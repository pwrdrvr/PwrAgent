import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const DESKTOP_SRC = path.resolve(import.meta.dirname, "../..");
const MAIN_SRC = path.join(DESKTOP_SRC, "main");
const RENDERER_SRC = path.join(DESKTOP_SRC, "renderer", "src");

const RAW_CONFIG_EXPORTS = new Set([
  "applyDesktopSettingsPatch",
  "parseDesktopSettingsToml",
  "readDesktopSettingsConfig",
]);

function productionSources(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "e2e") {
          visit(fullPath);
        }
        continue;
      }
      if (
        entry.isFile()
        && /\.(?:ts|tsx)$/.test(entry.name)
        && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
      ) {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

function relative(filePath: string): string {
  return path.relative(DESKTOP_SRC, filePath).replaceAll(path.sep, "/");
}

function sourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function calledMethodName(call: ts.CallExpression): string | undefined {
  return ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : undefined;
}

function containsPotentiallyTruthyProperty(
  node: ts.Node | undefined,
  propertyName: string,
): boolean {
  if (!node) return false;
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAssignment(current)
      && current.name.getText().replaceAll(/["']/g, "") === propertyName
      && current.initializer.kind !== ts.SyntaxKind.FalseKeyword
    ) {
      found = true;
      return;
    }
    if (
      ts.isShorthandPropertyAssignment(current)
      && current.name.text === propertyName
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function providerRefreshCalls(file: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = calledMethodName(node);
      if (
        method === "refreshCodexDiscovery"
        || (method === "listAcpAgents"
          && containsPotentiallyTruthyProperty(node.arguments[0], "refresh"))
        || (method === "listBackends"
          && containsPotentiallyTruthyProperty(
            node.arguments[0],
            "refreshModels",
          ))
      ) {
        calls.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

describe("desktop config/discovery source boundaries", () => {
  it("keeps raw config parsing and writing inside config-store", () => {
    const violations: string[] = [];
    for (const filePath of productionSources(MAIN_SRC)) {
      const file = sourceFile(filePath);
      for (const statement of file.statements) {
        if (
          !ts.isImportDeclaration(statement)
          || !ts.isStringLiteral(statement.moduleSpecifier)
          || !statement.moduleSpecifier.text.endsWith("desktop-config")
        ) {
          continue;
        }
        const imports = statement.importClause?.namedBindings;
        if (!imports || !ts.isNamedImports(imports)) continue;
        for (const element of imports.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (
            RAW_CONFIG_EXPORTS.has(imported)
            && !relative(filePath).startsWith("main/settings/config-store/")
          ) {
            violations.push(`${relative(filePath)} imports ${imported}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("allows discovery permits to be issued only at startup or user-action IPC", () => {
    const allowed = new Set([
      "main/index.ts",
      "main/ipc/agent-ipc.ts",
      "main/ipc/settings.ts",
    ]);
    const violations: string[] = [];
    for (const filePath of productionSources(MAIN_SRC)) {
      const file = sourceFile(filePath);
      const text = file.getFullText();
      if (
        text.includes("issueProviderDiscoveryPermit")
        && !relative(filePath).endsWith("provider-discovery-permit.ts")
        && !allowed.has(relative(filePath))
      ) {
        violations.push(relative(filePath));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps direct provider probes behind the permitted discovery owners", () => {
    const allowedLocalAcpProbeOwners = new Set([
      "main/app-server/acp-backend-adapter.ts",
      "main/ipc/settings.ts",
    ]);
    const violations: string[] = [];
    for (const filePath of productionSources(MAIN_SRC)) {
      const file = sourceFile(filePath);
      const text = file.getFullText();
      if (
        text.includes("discoverLocalAcpAgentRecords")
        && !relative(filePath).endsWith("acp/acp-instance-discovery.ts")
        && !allowedLocalAcpProbeOwners.has(relative(filePath))
      ) {
        violations.push(relative(filePath));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps Codex discovery and managed installs behind the settings service", () => {
    const restrictedImports = new Map<string, Set<string>>([
      ["codex-discovery-coordinator", new Set([
        "main/settings/desktop-settings-service.ts",
        "main/settings/desktop-settings-singleton.ts",
      ])],
      ["codex-managed-runtime", new Set([
        "main/settings/desktop-settings-service.ts",
        "main/settings/desktop-settings-singleton.ts",
      ])],
    ]);
    const violations: string[] = [];
    for (const filePath of productionSources(MAIN_SRC)) {
      const file = sourceFile(filePath);
      for (const statement of file.statements) {
        if (
          !ts.isImportDeclaration(statement)
          || !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          continue;
        }
        const moduleName = statement.moduleSpecifier.text.split("/").at(-1);
        const allowed = moduleName ? restrictedImports.get(moduleName) : undefined;
        if (allowed && !allowed.has(relative(filePath))) {
          violations.push(`${relative(filePath)} imports ${moduleName}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the full Settings projection inside Settings IPC", () => {
    const allowed = new Set([
      "main/ipc/settings.ts",
      "main/settings/desktop-settings-service.ts",
    ]);
    const violations = productionSources(MAIN_SRC)
      .filter((filePath) =>
        sourceFile(filePath).getFullText().includes("readSettingsProjection"),
      )
      .map(relative)
      .filter((filePath) => !allowed.has(filePath));
    expect(violations).toEqual([]);
  });

  it("allows startup provider refresh only from the startup coordinator", () => {
    const violations = productionSources(MAIN_SRC)
      .filter((filePath) =>
        sourceFile(filePath).getFullText().includes("refreshProvidersAtStartup"),
      )
      .map(relative)
      .filter((filePath) =>
        filePath !== "main/index.ts"
        && filePath !== "main/app-server/backend-registry.ts",
      );
    expect(violations).toEqual([]);
  });

  it("forbids runtime renderer surfaces from requesting provider refresh", () => {
    const allowedPrefixes = [
      "renderer/src/features/onboarding/",
      "renderer/src/features/settings/",
    ];
    const violations: string[] = [];
    for (const filePath of productionSources(RENDERER_SRC)) {
      const file = sourceFile(filePath);
      if (
        providerRefreshCalls(file).length > 0
        && !allowedPrefixes.some((prefix) => relative(filePath).startsWith(prefix))
      ) {
        violations.push(relative(filePath));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps whole Settings reads inside the Settings feature", () => {
    const violations = productionSources(RENDERER_SRC)
      .filter((filePath) =>
        sourceFile(filePath).getFullText().includes(".readSettings("),
      )
      .map(relative)
      .filter((filePath) =>
        !filePath.startsWith("renderer/src/features/settings/"),
      );
    expect(violations).toEqual([]);
  });
});
