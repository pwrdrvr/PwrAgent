import fc from "fast-check";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { IForbiddenRuleType } from "dependency-cruiser";
import ts from "typescript";
import { findOwnerBindingNames, findOwnerWiring, findOwnerImports } from "../../../../../scripts/check-desktop-owner-wiring.mjs";

// Measure the real parser at its boundary: repository discovery and generated
// snippets have very different costs. CPU here belongs to this Node worker,
// not to dependency-cruiser's child process or the other parallel workers.
const parsing = vi.hoisted(() => ({
  inventory: { files: 0, bytes: 0, wallMs: 0, cpuMicros: 0, parented: 0, jsDoc: 0 },
  snippets: { files: 0, bytes: 0, wallMs: 0, cpuMicros: 0, parented: 0, jsDoc: 0 },
}));
vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("typescript") }>();
  const ts = actual.default;
  return {
    ...actual,
    default: {
      ...ts,
      createSourceFile: (...args: Parameters<typeof ts.createSourceFile>) => {
        const metric = args[0].endsWith("negative-sample.ts") ? parsing.snippets : parsing.inventory;
        const started = performance.now();
        const cpu = process.cpuUsage();
        try {
          return ts.createSourceFile(...args);
        } finally {
          const used = process.cpuUsage(cpu);
          metric.files++;
          if (args[3]) metric.parented++;
          if (typeof args[2] !== "object" || args[2].jsDocParsingMode !== ts.JSDocParsingMode.ParseNone) metric.jsDoc++;
          metric.bytes += Buffer.byteLength(args[1]);
          metric.wallMs += performance.now() - started;
          metric.cpuMicros += used.user + used.system;
        }
      },
    },
  };
});

const require = createRequire(import.meta.url);
const config = require("../../../../../.dependency-cruiser.cjs") as { forbidden: IForbiddenRuleType[] };
const shellFile = fileURLToPath(new URL("../shell/negative-sample.ts", import.meta.url));
const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("rejects owner hookup calls through generated aliases and optional/computed access", () => {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const alias = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 2, maxLength: 12 })
    .map((letters) => `install_${letters.join("")}`);
  try {
    fc.assert(fc.property(alias, fc.constantFrom("onEvent", "setForgePrToolHandler", "setThreadDependencyToolHandler", "setMessagingAgentToolService"), (name, method) => {
      const sources = [
        `registry.${method}(handler);`,
        `registry?.${method}?.(handler);`,
        `registry["${method}"](handler);`,
        `const key = "${method}"; registry[key](handler);`,
        `const { ${method}: ${name} } = registry; ${name}(handler);`,
        `const ${name} = registry.${method}; ${name}(handler);`,
        `registry.${method}.call(registry, handler);`,
      ];
      for (const source of sources) expect(findOwnerWiring(source, shellFile).map((finding) => finding.method)).toEqual([method]);
    }));
  } finally {
    const used = process.cpuUsage(cpu);
    console.info("[owner-boundary-cost]", JSON.stringify({
      phase: "generated-property", pid: process.pid,
      wallMs: performance.now() - started, cpuMicros: used.user + used.system,
      parsing,
    }));
  }
});

it("rejects imported owner setter aliases, including removal during shutdown", () => {
  expect(findOwnerWiring('import { setInboundPreviewSink as install } from "../messaging/inbound-preview-bus"; install(undefined);', shellFile))
    .toMatchObject([{ method: "setInboundPreviewSink", line: 1 }]);
  expect(findOwnerWiring('registry.setForgeReadHandlers(undefined, undefined);', shellFile)).toHaveLength(1);
});

it("allows shell-only hooks, service requests, timers, comments and string literals", () => {
  const sources = [
    'import { setUpdateInstallPreparationHandler } from "./update-install-state"; setUpdateInstallPreparationHandler(handler);',
    'const note = "registry.onEvent(handler)"; // registry.setForgePrToolHandler(handler)',
    'registry.setThreadModelSettings(request); registry.startTurn(request);',
    'setTimeout(handler, 1); setInterval(handler, 1); window.webContents.setWindowOpenHandler(handler);',
    'service.setTranscriptPullRequests(request, sender.id, publish);',
  ];
  for (const source of sources) expect(findOwnerWiring(source, shellFile)).toEqual([]);
});

it("runs the actual dependency rules against forbidden imports and valid host edges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-owner-boundary-"));
  fixtures.push(root);
  const sources: Record<string, string> = {
    "apps/desktop/src/main/owner.ts": 'import { port } from "./shell/port"; export const value = port;',
    "apps/desktop/src/main/owner-electron.ts": 'import { app } from "electron"; export const value = app;',
    "apps/desktop/src/main/shell/port.ts": "export const port = 1;",
    "apps/desktop/src/main/shell/host.ts": 'import { app } from "electron"; export const value = app;',
    "apps/desktop/src/main/index.ts": 'import "./shell/host";',
    "apps/desktop/src/main/__tests__/owner.test.ts": 'import { app } from "electron"; import { port } from "../shell/port"; export const value = [app, port];',
    "node_modules/electron/package.json": '{"name":"electron","version":"1.0.0","main":"index.js"}',
    "node_modules/electron/index.js": "exports.app = {};",
  };
  for (const [name, source] of Object.entries(sources)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  const names = new Set(["desktop-owner-does-not-import-shell", "desktop-electron-is-shell-only"]);
  const rules = config.forbidden.filter((rule) => rule.name !== undefined && names.has(rule.name));
  expect(rules).toHaveLength(2);
  // Run the real resolver from the fixture cwd; no process-global chdir races.
  const script = path.join(root, "cruise.mjs");
  await writeFile(script, `import { cruise } from ${JSON.stringify(import.meta.resolve("dependency-cruiser"))};
const result = await cruise(["apps/desktop/src/main"], { outputType: "json", validate: true, ruleSet: ${JSON.stringify({ forbidden: rules })} });
const graph = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
process.stdout.write(JSON.stringify(graph.summary));
`);
  const started = performance.now();
  const cpu = process.cpuUsage();
  const { stdout } = await promisify(execFile)(process.execPath, [script], { cwd: root });
  const used = process.cpuUsage(cpu);
  console.info("[owner-boundary-cost]", JSON.stringify({
    phase: "dependency-cruiser-closed", pid: process.pid,
    wallMs: performance.now() - started, cpuMicros: used.user + used.system,
  }));
  const graph = { summary: JSON.parse(stdout) };
  expect(graph.summary.violations.map((violation: { rule: { name: string }; from: string }) => [violation.rule.name, violation.from]).sort())
    .toEqual([
      ["desktop-electron-is-shell-only", "apps/desktop/src/main/owner-electron.ts"],
      ["desktop-owner-does-not-import-shell", "apps/desktop/src/main/owner.ts"],
    ]);
});

it("rejects type-only, dynamic and re-exported owner imports without restricting tests or the thin shell entry", () => {
  const ownerFile = fileURLToPath(new URL("../negative-owner.ts", import.meta.url));
  for (const source of [
    'import type { BrowserWindow } from "electron";',
    'type Window = import("electron").BrowserWindow;',
    'const electron = await import("electron");',
    'export type { WindowShowThreadRequest } from "./shell/window-show-thread";',
    'import type { RequestShowThreadOptions } from "./shell/window-show-thread";',
  ]) expect(findOwnerImports(source, ownerFile)).toHaveLength(1);
  expect(findOwnerImports('import "./shell/index";', fileURLToPath(new URL("../index.ts", import.meta.url)))).toEqual([]);
  expect(findOwnerImports('import "electron";', import.meta.filename)).toEqual([]);
  expect(findOwnerImports('import "../app-server/backend-registry";', shellFile)).toEqual([]);
});

// The original declaration walk is the differential oracle. Keep its eager,
// parent-linked parser so the work-budget regression fails against pre-fix code.
function originalOwnerBindingNames(source: string, filename: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const bindingSuffix = /(?:Handlers?|Resolvers?|Publishers?|Canonicalizers?|Readers?|Writers?|Cleaners?|Services?|Actions|Projectors?|Advisory)$/;
  function containsFunctionType(node: ts.Node): boolean {
    if (ts.isFunctionTypeNode(node) || ts.isMethodSignature(node)) return true;
    return ts.forEachChild(node, containsFunctionType) === true;
  }
  function collect(node: ts.Node): void {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
      && node.name && ts.isIdentifier(node.name) && /^set[A-Z]/.test(node.name.text)
      && (bindingSuffix.test(node.name.text)
        || (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
          && (!node.type || node.type.kind === ts.SyntaxKind.VoidKeyword)
          && node.parameters.some(containsFunctionType)))) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);
  return [...names];
}

it("discovers exactly the original owner bindings across generated declaration forms and escaped identifiers", () => {
  const suffix = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 2, maxLength: 12 })
    .map((letters) => letters.join(""));
  fc.assert(fc.property(suffix, fc.constantFrom("function", "method", "signature"), fc.boolean(), (tail, kind, escaped) => {
    const name = `setGenerated${tail}`;
    const spelling = escaped ? `s\\u0065t\\u0047enerated${tail}` : name;
    const declaration = kind === "function"
      ? `function ${spelling}(handler: () => void): void {}`
      : kind === "method"
        ? `class Owner { ${spelling}(handler: () => void): void {} }`
        : `interface Owner { ${spelling}(handler: { run(): void }): void; }`;
    const source = `/** @param {() => void} handler */\n${declaration}\n`
      + `function setGenerated${tail}Handler(value: string): string { return value; }\n`
      + `async function setRequest${tail}(handler: () => void) {}\n`
      + `function setValue${tail}(value: string): string { return value; }\n`
      + `const note = "setFakeHandler"; // setCommentHandler()\n`;
    const actual = findOwnerBindingNames(source, "owner-fixture.ts").sort();
    expect(actual).toEqual(originalOwnerBindingNames(source, "owner-fixture.ts").sort());
    expect(actual).toEqual([name, `setGenerated${tail}Handler`].sort());
  }));
  for (const spelling of ["\\u0073etFixtureHandler", "\\u{73}etFixtureHandler", "set\\u0046ixtureHandler"]) {
    const source = `function ${spelling}(value: string) {}`;
    expect(findOwnerBindingNames(source, "escaped-fixture.ts")).toEqual(["setFixtureHandler"]);
    expect(findOwnerBindingNames(source, "escaped-fixture.ts")).toEqual(originalOwnerBindingNames(source, "escaped-fixture.ts"));
  }
});

it("bounds discovery work to candidate ASTs without parent or JSDoc construction, and rejects the original cost", () => {
  const checkBudget = (collect: typeof findOwnerBindingNames, source: string, parses: number) => {
    const before = { ...parsing.inventory };
    collect(source, "budget-fixture.ts");
    expect(parsing.inventory.files - before.files).toBe(parses);
    expect(parsing.inventory.parented - before.parented).toBe(0);
    expect(parsing.inventory.jsDoc - before.jsDoc).toBe(0);
  };
  fc.assert(fc.property(fc.nat(), (value) => {
    const source = `export function readValue${value}(): number { return ${value}; }`;
    checkBudget(findOwnerBindingNames, source, 0);
    expect(() => checkBudget(originalOwnerBindingNames, source, 0)).toThrow();
  }));
  const candidate = "/** @param {() => void} handler */ function setFixtureHandler(handler: () => void) {}";
  checkBudget(findOwnerBindingNames, candidate, 1);
  expect(() => checkBudget(originalOwnerBindingNames, candidate, 1)).toThrow();
});
