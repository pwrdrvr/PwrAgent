import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildMcpIpcRelay } from "./build-mcp-ipc-relay.mjs";
import { buildMcpStdioRelay } from "./build-mcp-stdio-relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildPrototypeHarness(outfile) {
  await build({
    entryPoints: [join(here, "windows-codex-mcp-prototype.mts")],
    outfile, bundle: true, platform: "node", format: "cjs", target: "node24",
    define: { "import.meta.url": "__prototypeUrl" },
    banner: { js: 'const __prototypeUrl = require("node:url").pathToFileURL(__filename).href;' },
    plugins: [{
      name: "owner-workflow-skill-text",
      setup(plugin) {
        plugin.onResolve({ filter: /\?raw$/ }, (args) =>
          ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw" }));
        plugin.onLoad({ filter: /.*/, namespace: "raw" }, async ({ path }) =>
          ({ contents: await readFile(path, "utf8"), loader: "text" }));
      },
    }],
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runNativePrototype();
}

async function runNativePrototype() {
  if (process.platform !== "win32") throw new Error("Run the admission oracle on native Windows.");
  const scratchRoot = resolve(here, "../.local");
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, "windows-codex-mcp-"));
  try {
    const native = buildMcpIpcRelay({ outputRoot: scratch, identityTest: true });
    const relay = buildMcpStdioRelay({ outputRoot: scratch });
    const runner = join(scratch, "prototype.cjs");
    await buildPrototypeHarness(runner);
    const codex = process.argv[2];
    const result = spawnSync(process.execPath, [runner, native, ...(codex ? [resolve(codex)] : [])], {
      env: { ...process.env, PWRAGENT_TEST_MCP_STDIO_RELAY: relay },
      stdio: "inherit", windowsHide: true, timeout: 85_000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
