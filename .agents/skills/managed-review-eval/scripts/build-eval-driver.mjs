#!/usr/bin/env node
/**
 * Bundle the headless managed-review eval driver and its sibling PwrAgent
 * headless workers into a disposable output directory (default: .local/).
 *
 * Usage:
 *   node .agents/skills/managed-review-eval/scripts/build-eval-driver.mjs \
 *     --repo /path/to/PwrAgnt \
 *     --out /path/to/PwrAgnt/.local/managed-review-eval/dist
 */
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepo = path.resolve(scriptDir, "../../../..");
const repoRoot = path.resolve(parseArg("--repo", defaultRepo));
const desktop = path.join(repoRoot, "apps/desktop");
const outdir = path.resolve(
  parseArg("--out", path.join(repoRoot, ".local/managed-review-eval/dist")),
);

const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");

await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    "review-matrix-driver": path.join(scriptDir, "review-matrix-driver.ts"),
    "storage-maintenance-worker": path.join(
      desktop,
      "src/main/state/storage-maintenance-worker.ts",
    ),
    "claude-session-reader-worker": path.join(
      desktop,
      "src/main/claude/claude-session-reader-worker.ts",
    ),
    "mcp-connection-bridge": path.join(
      desktop,
      "src/main/mcp-connections/mcp-connection-bridge-entry.ts",
    ),
    "token-miser-hook": path.join(
      desktop,
      "src/main/token-miser/token-miser-hook-entry.ts",
    ),
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: "external",
  logLevel: "info",
  absWorkingDir: desktop,
  nodePaths: [
    path.join(desktop, "node_modules"),
    path.join(repoRoot, "node_modules"),
  ],
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.url": "__pwragentModuleUrl",
    "import.meta.dirname": "__dirname",
  },
  banner: {
    js: 'const __pwragentModuleUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  plugins: [
    {
      name: "managed-review-eval-driver-deps",
      setup(builder) {
        builder.onResolve({ filter: /^electron(?:\/|$)/ }, () => {
          throw new Error("The headless eval driver cannot import Electron.");
        });
        builder.onResolve({ filter: /^@pwragent\/desktop-main\// }, (args) => {
          const subpath = args.path.slice("@pwragent/desktop-main/".length);
          return {
            path: path.join(desktop, "src/main", `${subpath}.ts`),
          };
        });
        builder.onResolve({ filter: /^@pwragent\/shared\// }, (args) => {
          const subpath = args.path.slice("@pwragent/shared/".length);
          return {
            path: path.join(repoRoot, "packages/shared/src", `${subpath}.ts`),
          };
        });
        builder.onResolve({ filter: /^[^./]/ }, (args) => {
          if (
            args.kind === "entry-point"
            || path.isAbsolute(args.path)
            || path.win32.isAbsolute(args.path)
            || args.path.startsWith("node:")
            || args.path.startsWith("@pwragent/")
            || args.path.startsWith("@pwrdrvr/codex-app-server-protocol")
          ) {
            return;
          }
          try {
            return { path: require.resolve(args.path), external: true };
          } catch {
            return;
          }
        });
        builder.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: "raw-data",
        }));
        builder.onLoad({ filter: /.*/, namespace: "raw-data" }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});

console.log(`Built managed-review-eval driver bundle into ${outdir}`);
