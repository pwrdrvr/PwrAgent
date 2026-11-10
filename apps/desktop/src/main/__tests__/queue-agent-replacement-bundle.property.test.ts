import fc from "fast-check";
import { expect, it } from "vitest";
import type { OnResolveArgs, OnResolveResult, PluginBuild } from "esbuild";
import { replacementHostDependencies } from "../../../e2e/fixtures/queue-agent-replacement-bundle";

function resolver() {
  let callback!: (args: OnResolveArgs) => OnResolveResult | undefined | null | Promise<OnResolveResult | undefined | null>;
  replacementHostDependencies(specifier => `/native/${specifier}`).setup({
    onResolve(_options: unknown, handler: typeof callback) { callback = handler; },
  } as PluginBuild);
  return (file: string, kind: OnResolveArgs["kind"]) => callback({ path: file, kind, importer: "", namespace: "file", resolveDir: "", pluginData: undefined, with: {} });
}

it("the actual replacement driver plugin keeps generated Windows and POSIX source paths inside esbuild", async () => {
  const resolve = resolver();
  await fc.assert(fc.asyncProperty(fc.constantFrom("C:\\", "D:/", "\\\\server\\share\\", "/tmp/"),
    fc.integer({ min: 0, max: 99 }), fc.constantFrom("entry-point" as const, "import-statement" as const), async (root, directory, kind) => {
      expect(await resolve(`${root}directory${directory}/queue-agent-replacement-driver.ts`, kind)).toBeUndefined();
    }), { examples: [["D:/", 0, "entry-point"], ["C:\\", 0, "import-statement"]] });
});

it("the actual plugin leaves relative entry points and workspace sources bundled while resolving bare native dependencies", async () => {
  const resolve = resolver();
  expect(await resolve("driver.ts", "entry-point")).toBeUndefined();
  for (const file of ["node:fs", "electron", "@pwragent/shared", "@pwrdrvr/codex-app-server-protocol"]) {
    expect(await resolve(file, "import-statement")).toBeUndefined();
  }
  expect(await resolve("better-sqlite3", "import-statement")).toEqual({ path: "/native/better-sqlite3", external: true });
});
