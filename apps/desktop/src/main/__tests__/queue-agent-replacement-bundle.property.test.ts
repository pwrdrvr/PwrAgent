import fc from "fast-check";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { build } from "esbuild";
import type { OnResolveArgs, OnResolveResult, PluginBuild } from "esbuild";
import { replacementHostDependencies } from "../../../e2e/fixtures/queue-agent-replacement-bundle";

function resolver(resolveDependency = (specifier: string) => `/native/${specifier}`) {
  let callback!: (args: OnResolveArgs) => OnResolveResult | undefined | null | Promise<OnResolveResult | undefined | null>;
  replacementHostDependencies(resolveDependency).setup({
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

it("lazy host imports round-trip through file URLs while CommonJS imports retain native paths", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("sdk", " ", "#", "%", "ü"), { minLength: 1, maxLength: 12 }), async (parts) => {
    const dependency = path.join(os.tmpdir(), `sdk-${parts.join("")}.mjs`);
    const resolve = resolver(() => dependency);
    const lazy = await resolve("fixture-sdk", "dynamic-import");
    expect(lazy?.external).toBe(true);
    expect(new URL(lazy!.path!).protocol).toBe("file:");
    expect(fileURLToPath(lazy!.path!)).toBe(dependency);
    for (const kind of ["import-statement", "require-call", "require-resolve"] as const) {
      expect(await resolve("fixture-sdk", kind)).toEqual({ path: dependency, external: true });
    }
  }), { examples: [[["sdk", " ", "#", "%", "ü"]]] });
});

it("Node's native ESM loader imports a lazy dependency from the real emitted driver", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replacement-sdk-"));
  try {
    const dependency = path.join(root, "sdk #% ü.mjs");
    const driver = path.join(root, "driver.cjs");
    await writeFile(dependency, `export const marker = "native-sdk-loaded";`);
    await build({
      stdin: { contents: `exports.load = () => import("fixture-sdk");`, resolveDir: root },
      outfile: driver, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
      plugins: [replacementHostDependencies(() => dependency)],
    });
    const { stdout } = await promisify(execFile)(process.execPath, ["-e",
      "require(process.argv[1]).load().then(module => process.stdout.write(module.marker));", driver]);
    expect(stdout).toBe("native-sdk-loaded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("the actual plugin leaves relative entry points and workspace sources bundled while resolving bare native dependencies", async () => {
  const resolve = resolver();
  expect(await resolve("driver.ts", "entry-point")).toBeUndefined();
  for (const file of ["node:fs", "electron", "@pwragent/shared", "@pwrdrvr/codex-app-server-protocol"]) {
    expect(await resolve(file, "import-statement")).toBeUndefined();
  }
  expect(await resolve("better-sqlite3", "import-statement")).toEqual({ path: "/native/better-sqlite3", external: true });
});
