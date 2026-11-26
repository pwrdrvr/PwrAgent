#!/usr/bin/env node
/**
 * Bundle the headless managed-review eval driver, the portable isolated
 * reviewer runner (plus sibling PwrAgent headless workers), and the direct
 * decision scorer into a disposable output directory.
 *
 * Supports `--prompt-file <path>` to inject a candidate override for
 * `managed-review-guidance-ledger.md` at bundle time without mutating source.
 *
 * Usage:
 *   node evals/managed-review/drivers/build-driver.mjs \
 *     --repo /path/to/PwrAgnt \
 *     --out evals/.cache/revs/worktree \
 *     [--prompt-file /path/to/variant.md]
 */
import { createRequire, isBuiltin } from "node:module";
import fs from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverWorkspacePackages,
  resolveWorkspacePackageSpecifier,
} from "../../shared/workspace-resolve.mjs";

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const evalsRoot = path.resolve(scriptDir, "../..");
const defaultRepo = fs.realpathSync(path.resolve(evalsRoot, ".."));
const defaultDesktop = path.join(defaultRepo, "apps/desktop");
const repoRoot = fs.realpathSync(path.resolve(parseArg("--repo", defaultRepo)));
const desktop = path.join(repoRoot, "apps/desktop");
const outdir = path.resolve(
  parseArg("--out", path.join(evalsRoot, ".cache/dist")),
);
const promptFileArg = parseArg("--prompt-file", "");
const promptFile = promptFileArg ? path.resolve(promptFileArg) : undefined;
if (promptFile && !fs.existsSync(promptFile)) {
  throw new Error(`Prompt override file not found: ${promptFile}`);
}
const isolatedOutdir = path.join(outdir, "isolated");

// Load esbuild from the tooling checkout so historical --rev worktrees never
// need donor node_modules symlinks.
const toolingRequire = createRequire(path.join(defaultDesktop, "package.json"));
const { build } = toolingRequire("esbuild");
const workspacePackages = discoverWorkspacePackages(repoRoot);

const PORTABLE_EXTERNALS = [
  "better-sqlite3",
  "node-pty",
  "@napi-rs/canvas",
  "pdfjs-dist",
  "electron-log/node",
  "electron-log/node.js",
];

function mapResolveDirToTooling(resolveDir) {
  if (!resolveDir || !path.isAbsolute(resolveDir)) return defaultDesktop;
  let canonicalDir = resolveDir;
  try {
    canonicalDir = fs.realpathSync(resolveDir);
  } catch {
    // Keep original if directory cannot be realpathed.
  }
  const relToTarget = path.relative(repoRoot, canonicalDir);
  if (relToTarget && !relToTarget.startsWith("..") && !path.isAbsolute(relToTarget)) {
    let candidate = path.join(defaultRepo, relToTarget);
    while (candidate.startsWith(defaultRepo)) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return defaultDesktop;
}

const candidateSiblingWorkers = {
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

// Older revisions (for example v1.5.1) may not have every newer worker file.
const siblingWorkers = Object.fromEntries(
  Object.entries(candidateSiblingWorkers).filter(([, file]) => fs.existsSync(file)),
);

const directScorerEntry = path.join(scriptDir, "direct-decision-scorer.ts");

function makeDepsPlugin({ portable }) {
  return {
    name: portable ? "managed-review-eval-isolated-deps" : "managed-review-eval-driver-deps",
    setup(builder) {
      builder.onResolve({ filter: /^electron(?:\/|$)/ }, () => {
        throw new Error("The headless eval driver cannot import Electron.");
      });
      builder.onResolve({ filter: /^@pwragent\// }, (args) => {
        const resolved = resolveWorkspacePackageSpecifier(args.path, repoRoot, workspacePackages);
        if (!resolved) {
          throw new Error(
            `Could not resolve workspace package "${args.path}" inside target revision ${repoRoot}.`,
          );
        }
        return { path: resolved };
      });
      builder.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (
          args.pluginData?.fromToolingResolve
          || args.kind === "entry-point"
          || path.isAbsolute(args.path)
          || path.win32.isAbsolute(args.path)
          || args.path.startsWith("node:")
          || isBuiltin(args.path)
          || args.path.startsWith("@pwragent/")
        ) {
          return;
        }
        // Transitive imports from inside tooling node_modules resolve natively.
        if (args.resolveDir && args.resolveDir.includes(`${path.sep}node_modules${path.sep}`)) {
          if (portable && PORTABLE_EXTERNALS.some((name) => args.path === name || args.path.startsWith(`${name}/`))) {
            return { path: args.path, external: true };
          }
          return;
        }
        const resolveFromTooling = async (kind = args.kind) => {
          const mappedDir = mapResolveDirToTooling(args.resolveDir);
          const primary = await builder.resolve(args.path, {
            resolveDir: mappedDir,
            kind,
            pluginData: { fromToolingResolve: true },
          });
          if (primary.path && primary.errors.length === 0) return primary;
          if (mappedDir !== defaultDesktop) {
            const fallback = await builder.resolve(args.path, {
              resolveDir: defaultDesktop,
              kind,
              pluginData: { fromToolingResolve: true },
            });
            if (fallback.path && fallback.errors.length === 0) return fallback;
          }
          return null;
        };
        if (args.path.startsWith("@pwrdrvr/codex-app-server-protocol")) {
          if (repoRoot !== defaultRepo) {
            const resolved = await resolveFromTooling();
            if (resolved) return { path: resolved.path, ...(resolved.external ? { external: true } : {}) };
          }
          return;
        }
        if (portable) {
          if (PORTABLE_EXTERNALS.some((name) => args.path === name || args.path.startsWith(`${name}/`))) {
            return { path: args.path, external: true };
          }
          if (repoRoot !== defaultRepo) {
            const resolved = await resolveFromTooling();
            if (resolved) return { path: resolved.path, ...(resolved.external ? { external: true } : {}) };
          }
          return;
        }
        if (repoRoot === defaultRepo) {
          try {
            return { path: toolingRequire.resolve(args.path), external: true };
          } catch {
            // Fall through to mapped resolver for per-package third-party deps.
          }
        }
        const resolved = await resolveFromTooling("require-call");
        if (resolved) {
          return { path: resolved.path, external: true };
        }
        return;
      });
      builder.onResolve({ filter: /\?raw$/ }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path.slice(0, -4));
        if (promptFile && path.basename(resolved) === "managed-review-guidance-ledger.md") {
          return {
            path: promptFile,
            namespace: "raw-data",
          };
        }
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
    ...(repoRoot !== defaultRepo
      ? [path.join(defaultDesktop, "node_modules"), path.join(defaultRepo, "node_modules")]
      : []),
  ].filter((dir) => fs.existsSync(dir)),
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

// 1. Local development matrix driver (+ optional direct decision scorer).
await build({
  ...commonOptions,
  entryPoints: {
    "review-matrix-driver": path.join(scriptDir, "matrix-driver.ts"),
    ...(fs.existsSync(directScorerEntry) ? { "direct-decision-scorer": directScorerEntry } : {}),
    ...siblingWorkers,
  },
  outdir,
  plugins: [makeDepsPlugin({ portable: false })],
});

// 2. Portable isolated reviewer runner + workers.
await build({
  ...commonOptions,
  entryPoints: {
    "isolated-review-runner": path.join(scriptDir, "isolated-runner.ts"),
    ...siblingWorkers,
  },
  outdir: isolatedOutdir,
  plugins: [makeDepsPlugin({ portable: true })],
});

console.log(`Built managed-review eval driver and portable isolated runner into ${outdir}`);
