import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { cruise } from "dependency-cruiser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../.dependency-cruiser.cjs";

const reusable = ["shared", "federation", "agent-tools", "messaging/interface"];
const providers = ["discord", "feishu", "line", "mattermost", "slack", "telegram"]
  .map((provider) => `messaging/providers/${provider}`);
const layers = [
  { path: "shared", imports: [] },
  { path: "federation", imports: ["shared"] },
  { path: "agent-tools", imports: ["shared"] },
  { path: "messaging/interface", imports: ["shared"] },
  { path: "owner-core", imports: ["shared"] },
  { path: "sqlite-storage", imports: ["shared", "owner-core"] },
  ...providers.map((path) => ({ path, imports: ["messaging/interface"] })),
  { path: "pwragent", imports: [...reusable, "owner-core", "sqlite-storage"] },
];
const targets = [
  ...layers.map(({ path }) => ({
    path,
    file: `packages/${path}/src/index.js`,
    name: path === "pwragent" ? path : `@pwragent/${path.replaceAll("/", "-").replace("messaging-providers-", "messaging-provider-")}`,
  })),
  { path: "desktop", file: "apps/desktop/src/main/index.js", name: "@pwragent/desktop" },
  { path: "future-library", file: "packages/future-library/src/index.js", name: "@pwragent/future-library" },
];
const cases = [];
const storageCases = [];
const ipcStateCases = [];
const outpostStorageCases = [];
let root;
let result;

function source(file, contents) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), contents);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pwragent-boundaries-")));
  for (const target of targets) source(target.file, "export const value = 1;\n");

  for (const layer of [...layers, { path: "desktop", imports: targets.map(({ path }) => path) }]) {
    for (const style of ["relative", "package"]) {
      for (const target of targets) {
        const directory = layer.path === "desktop" ? "apps/desktop" : `packages/${layer.path}`;
        const from = `${directory}/src/probes/${style}-${target.path.replaceAll("/", "-")}.js`;
        const specifier = style === "package" ? target.name : relative(dirname(from), target.file).replaceAll("\\", "/");
        source(from, `import ${JSON.stringify(specifier.startsWith(".") || style === "package" ? specifier : `./${specifier}`)};\n`);
        cases.push({
          from,
          to: target.file,
          allowed: target.path === layer.path
            || (layer.path !== "pwragent" && layer.imports.includes(target.path)),
        });
      }
    }
  }

  const entry = "packages/pwragent/src/federation-core.ts";
  source(entry, targets.map((target) => `export * from ${JSON.stringify(target.name)};`).join("\n"));
  for (const target of targets) {
    cases.push({
      from: entry,
      to: target.file,
      allowed: target.path === "pwragent" || [...reusable, "owner-core", "sqlite-storage"].includes(target.path),
    });
  }

  for (const target of [
    "apps/desktop/src/main/state/overlay.js",
    "node_modules/better-sqlite3/index.js",
    "node_modules/yaml/index.js",
    "node_modules/smol-toml/index.js",
    "packages/owner-core/src/registry.json",
    "packages/owner-core/src/registry.toml",
  ]) {
    source(target, target.endsWith(".json") ? "{}" : "export const value = 1;\n");
    const from = `packages/owner-core/src/probes/storage-${storageCases.length}.js`;
    source(from, `import ${JSON.stringify(relative(dirname(from), target).replaceAll("\\", "/"))};\n`);
    storageCases.push({ from, to: target });
  }

  for (const area of ["ipc", "ipc/nested", "app-server", "app-server/nested", "federation", "federation/nested", "composer-drafts", "composer-drafts/nested", "operator-requests", "operator-requests/nested", "pr-status", "pr-status/nested", "scheduled-actions", "scheduled-actions/nested", "thread-search", "thread-search/nested", "token-miser", "token-miser/nested", "thread-todos", "thread-todos/nested", "thread-reviews", "thread-reviews/nested", "acp", "acp/nested", "messaging", "messaging/nested", "settings", "settings/nested", "automations", "automations/nested", "mcp-connections", "mcp-connections/nested", "future-area", "future-area/nested"]) {
    for (const target of ["overlay", "app-state", "nested/store"]) {
      const to = `apps/desktop/src/main/state/${target}.js`;
      const from = `apps/desktop/src/main/${area}/state-${target.replaceAll("/", "-")}.js`;
      source(to, "export const value = 1;\n");
      source(from, `import ${JSON.stringify(relative(dirname(from), to).replaceAll("\\", "/"))};\n`);
      ipcStateCases.push({ from, to, forbidden: ["ipc", "app-server", "federation", "composer-drafts", "operator-requests", "pr-status", "scheduled-actions", "thread-search", "token-miser", "thread-todos", "thread-reviews", "acp", "messaging", "settings", "automations", "mcp-connections", "future-area"].includes(area.split("/")[0]) });
    }
  }

  // Moving SQLite below the host must preserve the same privacy for every
  // import syntax, including future application areas and root consumers.
  for (const area of ["ipc", "app-server", "federation", "settings", "messaging", "future-area", "state", "storage"]) {
    const to = "packages/sqlite-storage/src/index.js";
    for (const [style, statement] of [
      ["package", 'import "@pwragent/sqlite-storage";'],
      ["static", `import ${JSON.stringify(relative(`apps/desktop/src/main/${area}/nested`, to).replaceAll("\\", "/"))};`],
      ["type-import", 'import type { Value } from "@pwragent/sqlite-storage"; export type { Value };'],
      ["type-expression", 'export type Value = import("@pwragent/sqlite-storage").Value;'],
      ["type-export", 'export type { Value } from "@pwragent/sqlite-storage";'],
      ["export", 'export * from "@pwragent/sqlite-storage";'],
      ["dynamic", 'export const load = () => import("@pwragent/sqlite-storage");'],
      ["require", 'const value = require("@pwragent/sqlite-storage"); module.exports = value;'],
    ]) {
      const from = `apps/desktop/src/main/${area}/nested/sqlite-${style}.ts`;
      source(from, statement);
      ipcStateCases.push({ from, to, forbidden: !["state", "storage"].includes(area) });
    }
  }
  for (const consumer of ["index", "runtime-lease-manager", "future-root-service"]) {
    const to = "packages/sqlite-storage/src/index.js";
    const from = `apps/desktop/src/main/${consumer}-sqlite.ts`;
    source(from, 'export * from "@pwragent/sqlite-storage";');
    ipcStateCases.push({ from, to, forbidden: true });
  }
  for (const area of ["ipc", "app-server", "future-area", "state", "storage"]) {
    for (const binding of ["state-db", "app-runtime-instance-store", "thread-todo-store", "thread-review-storage-sqlite", "model-settings-recents-store", "overlay-store-sqlite", "thread-search-store", "provider-thread-snapshot-store", "automation-store", "scheduled-thread-action-store", "scheduled-thread-action-payload-store", "durable-turn-request-store", "acp-session-store", "acp-available-commands-store", "messaging-pairing-store", "messaging-activity-log", "operator-request-store", "token-miser-storage-sqlite", "acp-agent-store", "messaging-request-store", "messaging-store-sqlite", "federation-store", "thread-sandbox-store"]) {
      const to = `apps/desktop/src/main/storage/${binding}.ts`;
      const from = `apps/desktop/src/main/${area}/nested/sqlite-binding-${binding}.ts`;
      source(to, 'export * from "@pwragent/sqlite-storage";');
      source(from, `export * from "../../storage/${binding}";`);
      ipcStateCases.push({ from, to, forbidden: !["state", "storage"].includes(area) });
    }
  }

  for (const area of ["daemon", "runtime", "nested/future-owner"]) {
    for (const [style, statement] of [
      ["static", 'import "better-sqlite3";'],
      ["export", 'export * from "better-sqlite3";'],
      ["dynamic", 'export const load = () => import("better-sqlite3");'],
      ["require", 'module.exports = require("better-sqlite3");'],
      ["type", 'export type Value = import("better-sqlite3").Value;'],
    ]) {
      const from = `packages/pwragent/src/${area}-${style}.ts`;
      source(from, statement);
      outpostStorageCases.push({ from, to: "node_modules/better-sqlite3/index.js" });
    }
  }

  const settingsService = "apps/desktop/src/main/settings/desktop-settings-service.js";
  const settingsTargets = ["overlay", "app-state", "nested/store"]
    .map(target => `apps/desktop/src/main/state/${target}.js`);
  source(settingsService, settingsTargets
    .map(target => `import ${JSON.stringify(relative(dirname(settingsService), target).replaceAll("\\", "/"))};`).join("\n"));
  for (const to of settingsTargets) ipcStateCases.push({ from: settingsService, to, forbidden: true });

  for (const [style, statement] of [
    ["type-import", 'import type { Value } from "../../state/settings-contract";'],
    ["type-expression", 'export type Value = import("../../state/settings-contract").Value;'],
    ["type-export", 'export type { Value } from "../../state/settings-contract";'],
    ["export", 'export * from "../../state/settings-contract";'],
    ["dynamic", 'export const load = () => import("../../state/settings-contract");'],
  ]) {
    const to = "apps/desktop/src/main/state/settings-contract.ts";
    const from = `apps/desktop/src/main/settings/nested/${style}.ts`;
    source(to, "export interface Value { value: string; }\n");
    source(from, statement);
    ipcStateCases.push({ from, to, forbidden: true });
  }

  for (const area of ["automations", "mcp-connections", "future-area"]) {
    for (const [style, statement] of [
      ["static", 'import { value } from "../../state/application-contract"; export { value };'],
      ["type-import", 'import type { Value } from "../../state/application-contract"; export type { Value };'],
      ["type-expression", 'export type Value = import("../../state/application-contract").Value;'],
      ["type-export", 'export type { Value } from "../../state/application-contract";'],
      ["export", 'export * from "../../state/application-contract";'],
      ["dynamic", 'export const load = () => import("../../state/application-contract");'],
      ["require", 'const value = require("../../state/application-contract"); module.exports = value;'],
    ]) {
      const to = "apps/desktop/src/main/state/application-contract.ts";
      const from = `apps/desktop/src/main/${area}/nested/${style}.ts`;
      source(to, "export interface Value { value: string; }\nexport const value = 1;\n");
      source(from, statement);
      ipcStateCases.push({ from, to, forbidden: true });
    }
  }

  // Every root application module uses ports, including future consumers.
  for (const consumer of ["index", "navigation-browse-mode-bootstrap", "profile-service", "runtime-lease-manager", "runtime-messaging-lease", "storage-maintenance", "future-root-service"]) {
    for (const [style, statement] of [
      ["static", 'import { value } from "./state/root-contract"; export { value };'],
      ["type-import", 'import type { Value } from "./state/root-contract"; export type { Value };'],
      ["type-expression", 'export type Value = import("./state/root-contract").Value;'],
      ["type-export", 'export type { Value } from "./state/root-contract";'],
      ["export", 'export * from "./state/root-contract";'],
      ["dynamic", 'export const load = () => import("./state/root-contract");'],
    ]) {
      const to = "apps/desktop/src/main/state/root-contract.ts";
      const from = `apps/desktop/src/main/${consumer}-${style}.ts`;
      source(to, "export interface Value { value: string; }\nexport const value = 1;\n");
      source(from, statement);
      ipcStateCases.push({ from, to, forbidden: true });
    }
  }

  // dependency-cruiser normalizes entry paths against cwd, even with baseDir.
  // This suite runs in the desktop-main fork, so the fixture owns its cwd.
  const previousDirectory = process.cwd();
  try {
    process.chdir(root);
    ({ output: result } = await cruise(["packages", "apps"], {
      validate: true,
      tsPreCompilationDeps: true,
      ruleSet: { forbidden: config.forbidden },
      outputType: "json",
    }, {
      alias: Object.fromEntries(targets.map((target) => [target.name, join(root, target.file)])),
    }));
  } finally {
    process.chdir(previousDirectory);
  }
  if (typeof result === "string") result = JSON.parse(result);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("workspace dependency layers", () => {
  it("resolves every fixture import", () => {
    const unresolved = result.modules.flatMap((module) => module.dependencies
      .filter((dependency) => dependency.couldNotResolve)
      .map((dependency) => `${module.source}: ${dependency.module}`));
    expect(unresolved).toEqual([]);
  });

  it("enforces the layer matrix for package and relative imports, including owner-core", () => {
    const mismatches = [];
    for (const { from, to, allowed } of cases) {
      const dependency = result.modules.find((module) => module.source === from)
        ?.dependencies.find((dependency) => dependency.resolved === to);
      if (!dependency || dependency.valid !== allowed) {
        mismatches.push({ from, to, allowed, rules: dependency?.rules });
      }
    }
    expect({ count: mismatches.length, first: mismatches.slice(0, 10) }).toEqual({ count: 0, first: [] });
  });

  it("keeps Outpost application modules out of raw native storage for every import syntax", () => {
    for (const { from, to } of outpostStorageCases) {
      const dependency = result.modules.find(module => module.source === from)
        ?.dependencies.find(dependency => dependency.resolved === to);
      expect(dependency?.rules?.map(rule => rule.name), `${from} -> ${to}`)
        .toContain("outpost-application-storage-is-private");
    }
  });

  it("keeps every forbidden rule fatal", () => {
    expect(config.forbidden.every((rule) => rule.severity === "error")).toBe(true);
  });

  it("blocks owner storage formats", () => {
    for (const { from, to } of storageCases) {
      const dependency = result.modules.find((module) => module.source === from)
        ?.dependencies.find((dependency) => dependency.resolved === to);
      expect(dependency?.rules?.map((rule) => rule.name), `${from} -> ${to}`)
        .toContain("owner-core-has-no-storage-format-dependencies");
    }
  });

  it("keeps completed desktop state boundaries private at every nesting depth", () => {
    for (const { from, to, forbidden } of ipcStateCases) {
      const dependency = result.modules.find((module) => module.source === from)
        ?.dependencies.find((dependency) => dependency.resolved === to);
      expect(dependency, `${from} -> ${to}`).toBeDefined();
      expect(dependency.rules?.some((rule) => rule.name === "desktop-ipc-state-is-service-private") ?? false,
        `${from} -> ${to}`).toBe(forbidden);
    }
  });
});
