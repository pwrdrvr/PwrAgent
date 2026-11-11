import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(desktop, "package.json"));
export const headlessEntries = {
  index: "src/main/headless/index.ts",
  "storage-maintenance-worker": "src/main/state/storage-maintenance-worker.ts",
  "claude-session-reader-worker": "src/main/claude/claude-session-reader-worker.ts",
  "mcp-connection-bridge": "src/main/mcp-connections/mcp-connection-bridge-entry.ts",
  "token-miser-hook": "src/main/token-miser/token-miser-hook-entry.ts",
};

export async function buildHeadless({ outputDirectory = path.join(desktop, "out/headless"), plugins = [], portable = false } = {}) {
  const outdir = outputDirectory;
  const result = await build({
    metafile: true,
    entryPoints: Object.fromEntries(Object.entries(headlessEntries).map(([name, entry]) => [name, path.join(desktop, entry)])),
    outdir, bundle: true, platform: "node", target: "node24", format: "cjs", sourcemap: "external", logLevel: "info",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.url": "__pwragentModuleUrl", "import.meta.dirname": "__dirname" },
    banner: { js: 'const __pwragentModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
    plugins: [...plugins, { name: "headless-host-dependencies", setup(builder) {
      builder.onResolve({ filter: /^electron(?:\/|$)/ }, () => { throw new Error("The headless runtime cannot import Electron."); });
      builder.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === "entry-point" || path.isAbsolute(args.path) || path.win32.isAbsolute(args.path)
          || args.path.startsWith("node:") || args.path.startsWith("@pwragent/") || args.path.startsWith("@pwrdrvr/codex-app-server-protocol")) return;
        if (portable) {
          if (["better-sqlite3", "node-pty", "@napi-rs/canvas", "pdfjs-dist", "electron-log/node", "electron-log/node.js"].some(name => args.path === name || args.path.startsWith(name + "/"))) return { path: args.path, external: true };
          return;
        }
        try { return { path: require.resolve(args.path), external: true }; } catch { return; }
      });
      builder.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw-data" }));
      builder.onLoad({ filter: /.*/, namespace: "raw-data" }, async (args) => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
    } }],
  });
  const info = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  await mkdir(outdir, { recursive: true });
  await writeFile(path.join(outdir, "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
  await writeFile(path.join(outdir, "runtime.json"), JSON.stringify({ version: 1, appVersion: info.version, appRoot: portable ? ".." : path.relative(outdir, desktop), resources: portable ? "../resources" : path.relative(outdir, path.join(desktop, "resources")) }) + "\n");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildHeadless();
