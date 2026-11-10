import fc from "fast-check";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { IForbiddenRuleType } from "dependency-cruiser";
import { findOwnerWiring, findOwnerImports } from "../../../../../scripts/check-desktop-owner-wiring.mjs";

const require = createRequire(import.meta.url);
const config = require("../../../../../.dependency-cruiser.cjs") as { forbidden: IForbiddenRuleType[] };
const shellFile = fileURLToPath(new URL("../shell/negative-sample.ts", import.meta.url));
const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("rejects owner hookup calls through generated aliases and optional/computed access", () => {
  const alias = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 2, maxLength: 12 })
    .map((letters) => `install_${letters.join("")}`);
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
  const { stdout } = await promisify(execFile)(process.execPath, [script], { cwd: root });
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
