import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { buildHeadless as buildHeadlessRuntime } from "../../../../scripts/build-headless.mjs";

export async function buildHeadlessDriverFixture(root: string, buildHeadless: typeof buildHeadlessRuntime) {
  const outputDirectory = path.join(root, "runtime");
  const fixture = path.join(import.meta.dirname, "../fixtures/owner-conformance-codex-transport.ts");
  await buildHeadless({ outputDirectory, sourcemap: false, logLevel: "warning", plugins: [{ name: "conformance-provider", setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)stdio-transport$/ }, () => ({ path: "fixture-codex", namespace: "owned-codex" }));
    builder.onLoad({ filter: /.*/, namespace: "owned-codex" }, () => ({
      contents: `export { OwnerConformanceCodexTransport as StdioJsonRpcTransport } from ${JSON.stringify(fixture)};`, loader: "ts", resolveDir: path.dirname(fixture),
    }));
    builder.onLoad({ filter: /headless[\\/]index\.ts$/ }, (args) => ({
      contents: fs.readFileSync(args.path, "utf8") + `\nexport { OwnerConformanceCodexTransport as fixtureCodex } from ${JSON.stringify(fixture)};`, loader: "ts",
    }));
  } }] });
  const guard = path.join(root, "guard.cjs");
  await build({
    entryPoints: [path.join(import.meta.dirname, "../setup/agent-cli-spawn-guard.ts")], outfile: guard,
    bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "child-hooks", setup(builder) {
      builder.onResolve({ filter: /^vitest$/ }, () => ({ path: "hooks", namespace: "child-test" }));
      builder.onLoad({ filter: /.*/, namespace: "child-test" }, () => ({
        contents: `export const afterEach = () => {}; export const afterAll = fn => process.once("exit", () => { try { fn(); } catch (error) { require("node:fs").writeSync(2, error.message + "\\n"); process.exitCode = 1; } });`, loader: "js",
      }));
    } }],
  });
  return { outputDirectory, guard };
}
