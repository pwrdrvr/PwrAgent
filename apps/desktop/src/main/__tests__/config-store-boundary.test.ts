import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const DESKTOP_SRC = path.resolve(import.meta.dirname, "../..");
const MAIN_SRC = path.join(DESKTOP_SRC, "main");
const RENDERER_SRC = path.join(DESKTOP_SRC, "renderer", "src");

// The module the raw-config exports live in. Both the import check and its text
// pre-filter read this one spelling.
const RAW_CONFIG_MODULE = "desktop-config";
const RAW_CONFIG_EXPORTS = new Set([
  "applyDesktopSettingsPatch",
  "parseDesktopSettingsToml",
  "readDesktopSettingsConfig",
]);

// Every check below sweeps one of two whole source trees, and the trees do not
// change while the file runs. Each of the eight tests used to re-walk the
// directories, re-read ~940 files and re-parse them with the TypeScript
// compiler — which was the entire runtime of this file (~10s on Linux and
// macOS, ~8s on Windows) and none of its coverage.
//
// What actually removed that cost is `parsedSourcesContaining`, which parses
// only the files whose text could implicate them. These caches are what keeps
// the rest cheap: the walk happens once per tree, each file is read once, and
// the few files that two different needle sets both match are parsed once.
//
// `sourceTextCache` ends up holding the text of both trees (~15 MB) for as
// long as the module is loaded. Six checks scan a whole tree for a symbol, so
// the reads have to happen either way; only the retention is a choice.
const sourceListCache = new Map<string, string[]>();
const sourceTextCache = new Map<string, string>();
const sourceFileCache = new Map<string, ts.SourceFile>();

function productionSources(root: string): string[] {
  const cached = sourceListCache.get(root);
  // `!== undefined`, not truthiness: an empty walk is a legitimate answer to
  // cache, and a falsy check on `[]` would miss it and re-walk the tree. The
  // roots have files today, which is exactly why it would go unnoticed.
  if (cached !== undefined) return cached;
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
  sourceListCache.set(root, files);
  return files;
}

function relative(filePath: string): string {
  return path.relative(DESKTOP_SRC, filePath).replaceAll(path.sep, "/");
}

// For the checks that only look for a symbol by name. `getFullText()` on a
// SourceFile returns exactly this string, so parsing first bought nothing.
function sourceText(filePath: string): string {
  let text = sourceTextCache.get(filePath);
  if (text === undefined) {
    text = fs.readFileSync(filePath, "utf8");
    sourceTextCache.set(filePath, text);
  }
  return text;
}

// The text half of the same idea: paths under `root` whose source mentions
// `needle`. Shares `parsedSourcesContaining`'s zero-match rule for the same
// reason — a needle that stopped matching leaves the caller filtering an empty
// list and passing.
function sourcesMentioning(root: string, needle: string): string[] {
  const matched = productionSources(root)
    .filter((filePath) => sourceText(filePath).includes(needle));
  if (matched.length === 0) {
    throw new Error(
      `No source under ${relative(root)} mentions ${needle}; the boundary `
      + "check that looks for it can no longer fail.",
    );
  }
  return matched;
}

// Parses only the files that could possibly violate the rule, which on these
// trees is a handful out of ~940. A node the check looks for — an import
// specifier, a called method name — cannot exist in the AST unless its spelling
// exists in the text. Every caller derives its needles from the same constant
// the check itself matches on, so the two cannot drift apart.
//
// One narrowing against a full sweep, recorded rather than implied away: a
// check reads `moduleSpecifier.text`, which is the cooked value, so an import
// written `"./desktop\u002Dconfig"` resolves to a match the raw text does not
// contain. These rules guard against an honest mistake, not evasion, and no
// import in either tree is written that way.
function parsedSourcesContaining(
  root: string,
  needles: readonly string[],
): ts.SourceFile[] {
  const matched = productionSources(root)
    .filter((filePath) => {
      const text = sourceText(filePath);
      return needles.some((needle) => text.includes(needle));
    })
    .map(sourceFile);
  // The filter's failure mode is silence: a needle that stopped matching
  // anything leaves the caller sweeping an empty list and passing. Every rule
  // here names a symbol its own permitted owners use, so zero matches means
  // the rule is no longer looking at anything, not that the tree is clean.
  if (matched.length === 0) {
    throw new Error(
      `No source under ${relative(root)} contains any of ${needles.join(", ")}; `
      + "the boundary check that filtered on them can no longer fail.",
    );
  }
  return matched;
}

// Reached only through `parsedSourcesContaining`. `ts.SourceFile` is immutable
// and nothing here mutates one, so the cache lets two checks whose needles both
// match a file share its parse.
function sourceFile(filePath: string): ts.SourceFile {
  let file = sourceFileCache.get(filePath);
  if (!file) {
    file = ts.createSourceFile(
      filePath,
      sourceText(filePath),
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    sourceFileCache.set(filePath, file);
  }
  return file;
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

// Method name -> the option that has to be truthy for the call to count as a
// provider refresh, or `undefined` when the call always counts.
//
// The walk below and the text pre-filter that decides which files reach it
// both read this map, so adding a method here extends both at once. A parallel
// list would not: the pre-filter would keep skipping files that use only the
// new name, `parsedSourcesContaining` would still find matches for the older
// ones and so would not throw, and the check would go quiet.
//
// Only `x.method(...)` call sites are matched, because `calledMethodName`
// resolves a name from a property access and nothing else. A destructured
// `const { listAcpAgents } = api` call is invisible to this and always has
// been; widening it means matching identifiers against imports, which is a
// bigger change than this file wants.
const PROVIDER_REFRESH_METHODS = new Map<string, string | undefined>([
  ["refreshCodexDiscovery", undefined],
  ["listAcpAgents", "refresh"],
  ["listBackends", "refreshModels"],
]);

function providerRefreshCalls(file: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = calledMethodName(node);
      if (method !== undefined && PROVIDER_REFRESH_METHODS.has(method)) {
        const requiredOption = PROVIDER_REFRESH_METHODS.get(method);
        if (
          requiredOption === undefined
          || containsPotentiallyTruthyProperty(node.arguments[0], requiredOption)
        ) {
          calls.push(node);
        }
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
    for (const file of parsedSourcesContaining(MAIN_SRC, [RAW_CONFIG_MODULE])) {
      for (const statement of file.statements) {
        if (
          !ts.isImportDeclaration(statement)
          || !ts.isStringLiteral(statement.moduleSpecifier)
          || !statement.moduleSpecifier.text.endsWith(RAW_CONFIG_MODULE)
        ) {
          continue;
        }
        const imports = statement.importClause?.namedBindings;
        if (!imports || !ts.isNamedImports(imports)) continue;
        for (const element of imports.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (
            RAW_CONFIG_EXPORTS.has(imported)
            && !relative(file.fileName).startsWith("main/settings/config-store/")
          ) {
            violations.push(`${relative(file.fileName)} imports ${imported}`);
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
    for (const filePath of sourcesMentioning(
      MAIN_SRC,
      "issueProviderDiscoveryPermit",
    )) {
      if (
        !relative(filePath).endsWith("provider-discovery-permit.ts")
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
    for (const filePath of sourcesMentioning(
      MAIN_SRC,
      "discoverLocalAcpAgentRecords",
    )) {
      if (
        !relative(filePath).endsWith("acp/acp-instance-discovery.ts")
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
    for (const file of parsedSourcesContaining(
      MAIN_SRC,
      [...restrictedImports.keys()],
    )) {
      for (const statement of file.statements) {
        if (
          !ts.isImportDeclaration(statement)
          || !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          continue;
        }
        const moduleName = statement.moduleSpecifier.text.split("/").at(-1);
        const allowed = moduleName ? restrictedImports.get(moduleName) : undefined;
        if (allowed && !allowed.has(relative(file.fileName))) {
          violations.push(`${relative(file.fileName)} imports ${moduleName}`);
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
    const violations = sourcesMentioning(MAIN_SRC, "readSettingsProjection")
      .map(relative)
      .filter((filePath) => !allowed.has(filePath));
    expect(violations).toEqual([]);
  });

  it("allows startup provider refresh only from the startup coordinator", () => {
    const violations = sourcesMentioning(MAIN_SRC, "refreshProvidersAtStartup")
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
    for (const file of parsedSourcesContaining(
      RENDERER_SRC,
      [...PROVIDER_REFRESH_METHODS.keys()],
    )) {
      if (
        providerRefreshCalls(file).length > 0
        && !allowedPrefixes.some((prefix) =>
          relative(file.fileName).startsWith(prefix),
        )
      ) {
        violations.push(relative(file.fileName));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps whole Settings reads inside the Settings feature", () => {
    const violations = sourcesMentioning(RENDERER_SRC, ".readSettings(")
      .map(relative)
      .filter((filePath) =>
        !filePath.startsWith("renderer/src/features/settings/"),
      );
    expect(violations).toEqual([]);
  });
});
