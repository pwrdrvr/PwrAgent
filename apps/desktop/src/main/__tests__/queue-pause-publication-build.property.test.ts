import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { ImportKind, OnResolveOptions, OnResolveResult, PluginBuild } from "esbuild";
import { queuePausePublicationPlugin } from "../../../e2e/fixtures/queue-pause-publication-build";

type ResolveCallback = Parameters<PluginBuild["onResolve"]>[1];

function fixture() {
  const callbacks: Array<{ options: OnResolveOptions; callback: ResolveCallback }> = [];
  const dependencies: string[] = [];
  const resolved = (id: string) => `/fixture/node_modules/${id}/index.js`;
  // Only esbuild's hook registration and the host's successful module lookup
  // are supplied. Every filter and resolution decision is the real E2E plugin.
  const plugin = queuePausePublicationPlugin("/fixture/e2e", id => { dependencies.push(id); return resolved(id); });
  plugin.setup({
    onResolve: (options: OnResolveOptions, callback: ResolveCallback) => { callbacks.push({ options, callback }); },
    onLoad: () => {},
  } as unknown as PluginBuild);
  return { dependencies, resolved, resolve: async (specifier: string, kind: ImportKind): Promise<OnResolveResult | undefined> => {
    for (const { options, callback } of callbacks) {
      if (!options.filter.test(specifier)) continue;
      const result = await callback({ path: specifier, importer: "", namespace: "file", resolveDir: "/fixture", kind, pluginData: undefined, with: {} });
      if (result) return result;
    }
    return undefined;
  } };
}

const windowsFile = fc.tuple(fc.constantFrom("C", "D", "Z"), fc.array(fc.nat(999), { minLength: 1, maxLength: 5 }))
  .map(([drive, directories]) => path.win32.join(`${drive}:\\`, ...directories.map(n => `directory${n}`), "queue-pause-publication-driver.ts"));
const absoluteWindowsFile = fc.oneof(windowsFile, windowsFile.map(file => file.replaceAll("\\", "/")),
  fc.nat(999).map(n => `\\\\server\\share\\directory${n}\\driver.ts`));

it("never treats generated Windows file entry points as external dependencies", async () => {
  await fc.assert(fc.asyncProperty(absoluteWindowsFile, async file => {
    expect(path.win32.isAbsolute(file)).toBe(true);
    const host = fixture();
    expect(await host.resolve(file, "entry-point")).toBeUndefined();
    expect(host.dependencies).toEqual([]);
  }), { examples: [["C:\\directory0\\queue-pause-publication-driver.ts"]] });
});

it("leaves generated absolute Windows source imports with esbuild", async () => {
  await fc.assert(fc.asyncProperty(absoluteWindowsFile, fc.constantFrom("import-statement", "require-call", "dynamic-import"), async (file, kind) => {
    const host = fixture();
    expect(await host.resolve(file, kind)).toBeUndefined();
    expect(host.dependencies).toEqual([]);
  }), { examples: [["C:\\directory0\\queue-pause-publication-driver.ts", "import-statement"]] });
});

it("leaves relative entry points with esbuild even when host module lookup succeeds", async () => {
  const host = fixture();
  expect(await host.resolve("driver.ts", "entry-point")).toBeUndefined();
  expect(host.dependencies).toEqual([]);
});

it("keeps the exact failed Windows driver entry point in the bundle", async () => {
  const host = fixture();
  expect(await host.resolve("D:\\a\\PwrAgent\\PwrAgent\\apps\\desktop\\e2e\\fixtures\\queue-pause-publication-driver.ts", "entry-point")).toBeUndefined();
  expect(host.dependencies).toEqual([]);
});

it("still externalizes bare dependencies while retaining workspace sources and host builtins", async () => {
  for (const specifier of ["better-sqlite3", "node-pty", "@opentelemetry/api"]) {
    const host = fixture();
    expect(await host.resolve(specifier, "import-statement")).toEqual({ path: host.resolved(specifier), external: true });
    expect(host.dependencies).toEqual([specifier]);
  }
  for (const specifier of ["node:fs", "electron", "@pwragent/owner-core/thread-turn-queue", "@pwrdrvr/codex-app-server-protocol", "./driver.ts", "/fixture/driver.ts"]) {
    const host = fixture();
    expect(await host.resolve(specifier, "import-statement")).toBeUndefined();
    expect(host.dependencies).toEqual([]);
  }
});
