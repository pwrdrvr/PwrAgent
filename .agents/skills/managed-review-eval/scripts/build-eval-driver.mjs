#!/usr/bin/env node
/**
 * Bundle the headless managed-review eval driver and the portable isolated
 * reviewer runner (plus sibling PwrAgent headless workers) into a disposable
 * output directory (default: .local/managed-review-eval/dist).
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
const isolatedOutdir = path.join(outdir, "isolated");

const require = createRequire(path.join(desktop, "package.json"));
const { build } = require("esbuild");

const PORTABLE_EXTERNALS = [
  "better-sqlite3",
  "node-pty",
  "@napi-rs/canvas",
  "pdfjs-dist",
  "electron-log/node",
  "electron-log/node.js",
];

const siblingWorkers = {
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
};

function makeDepsPlugin({ portable }) {
  return {
    name: portable ? "managed-review-eval-isolated-deps" : "managed-review-eval-driver-deps",
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
        if (portable) {
          if (PORTABLE_EXTERNALS.some((name) => args.path === name || args.path.startsWith(`${name}/`))) {
            return { path: args.path, external: true };
          }
          // Bundle pure-JS dependencies inline so no host node_modules paths
          // are embedded in the isolated runner bundle.
          return;
        }
        try {
          return { path: require.resolve(args.path), external: true };
        } catch {
          return;
        }
      });
      builder.onResolve({ filter: /\?raw$/ }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path.slice(0, -4));
        return {
          path: portable ? path.relative(repoRoot, resolved).split(path.sep).join("/") : resolved,
          namespace: "raw-data",
        };
      });
      builder.onLoad({ filter: /.*/, namespace: "raw-data" }, async (args) => {
        const file = path.isAbsolute(args.path) ? args.path : path.resolve(repoRoot, args.path);
        return {
          contents: await readFile(file, "utf8"),
          loader: "text",
        };
      });
    },
  };
}

const commonOptions = {
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
};

await mkdir(outdir, { recursive: true });
await mkdir(isolatedOutdir, { recursive: true });

// 1. Local development matrix driver (keeps existing node_modules resolution).
await build({
  ...commonOptions,
  entryPoints: {
    "review-matrix-driver": path.join(scriptDir, "review-matrix-driver.ts"),
    ...siblingWorkers,
  },
  outdir,
  plugins: [makeDepsPlugin({ portable: false })],
});

// 2. Portable isolated reviewer runner + workers (bundles pure-JS deps and
//    keeps only native/runtime externals as bare specifiers, with zero host
//    checkout paths embedded).
await build({
  ...commonOptions,
  entryPoints: {
    "isolated-review-runner": path.join(scriptDir, "isolated-review-runner.ts"),
    ...siblingWorkers,
  },
  outdir: isolatedOutdir,
  plugins: [makeDepsPlugin({ portable: true })],
});

console.log(`Built managed-review-eval driver and portable isolated runner into ${outdir}`);
