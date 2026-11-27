import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { build, type BuildOptions, type BuildResult, type Plugin } from "esbuild";
import ts from "typescript";

const desktop = path.resolve(import.meta.dirname, "../../../..");
const main = path.join(desktop, "src/main");
export const accessMarker = "__PWRAGENT_OWNER_GETTER_ORACLE__";
export const FILE_KEY_NAME = "headless-secret.key";
export type OracleBuildOptions = BuildOptions & { write: false };

export async function desktopEntryHasFileKey(): Promise<boolean> {
  const output = await bundleProductionEntry(build, "src/main/index.ts");
  return output.includes(FILE_KEY_NAME);
}

export function source(file: string, text = fs.readFileSync(file, "utf8")): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

// Instrument the actual loud getters, not their import sites. Tree shaking must
// remove every marker from an owner-free entry, even when access would happen
// only in a future worker message/callback. Never execute a production worker.
export type BundleCost = { parses: number; loads: number; candidates: number; bytes: number; inputs: number; inputBytes: number; parseMs: number; loadMs: number };
const activeBundles = new Set<string>();

export function instrumentOwnerGetters(file: string, text: string, cost?: BundleCost): string {
  // This is a necessary condition of the AST predicate below, including text
  // in comments and literals. Keep every module in the executable graph while
  // avoiding a second parser for modules that cannot contain a loud getter.
  if (!text.includes("before startOwnerServices")) return text;
  return instrumentCandidate(file, text, cost);
}

// The original unfiltered instrumenter remains the differential oracle.
export function instrumentCandidate(file: string, text: string, cost?: BundleCost): string {
  const started = performance.now();
  const parsed = source(file, text);
  if (cost) {
    cost.parses++;
    cost.parseMs += performance.now() - started;
  }
  const insertions: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith("get") && node.body
      && node.body.getText(parsed).includes("before startOwnerServices")) {
      insertions.push(node.body.getStart(parsed) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const offset of insertions.sort((a, b) => b - a)) {
    text = `${text.slice(0, offset)}globalThis.${accessMarker}?.();${text.slice(offset)}`;
  }
  return text;
}
function oraclePlugin(cost: BundleCost): Plugin {
  return {
    name: "production-owner-getter-oracle",
    setup(builder) {
      builder.onResolve({ filter: /^@renderer\// }, (args) => ({ path: path.join(desktop, "src/renderer/src", args.path.slice("@renderer/".length)) }));
      builder.onResolve({ filter: /^\.\/(?:stage-runtime|build-mcp-ipc-relay)\.mjs$/ }, args => {
        if (args.importer === path.resolve(desktop, "../../packages/pwragent/scripts/install.mjs")) {
          return { path: path.join(desktop, "scripts", path.basename(args.path)) };
        }
      });
      // Assets and third-party packages cannot import desktop owner modules.
      // Vite's worker wrapper is data here; the worker itself has its own case.
      builder.onResolve({ filter: /\.(?:css|svg|png|webp|jpg|woff2?|wasm)(?:\?.*)?$|\?(?:raw|url|worker)/ }, () => ({ external: true }));
      builder.onLoad({ filter: /\.(?:[cm]?tsx?|worklet\.js)$/ }, (args) => {
        const started = performance.now();
        const text = fs.readFileSync(args.path, "utf8");
        cost.loads++;
        cost.bytes += Buffer.byteLength(text);
        if (text.includes("before startOwnerServices")) cost.candidates++;
        const contents = instrumentOwnerGetters(args.path, text, cost);
        cost.loadMs += performance.now() - started;
        const loader = args.path.endsWith(".js") ? "js" : args.path.endsWith(".tsx") ? "tsx" : "ts";
        return { contents, loader };
      });
    },
  };
}
export async function bundleProductionEntry(compile: (options: OracleBuildOptions) => Promise<BuildResult<OracleBuildOptions>>, entry: string, extraSource?: string): Promise<string> {
  const cost: BundleCost = { parses: 0, loads: 0, candidates: 0, bytes: 0, inputs: 0, inputBytes: 0, parseMs: 0, loadMs: 0 };
  const label = entry || extraSource!;
  const overlap = [...activeBundles];
  activeBundles.add(label);
  const started = performance.now();
  const cpu = process.cpuUsage();
  try {
    const result = await compile({
      metafile: true,
      ...(extraSource === undefined ? { entryPoints: [path.join(desktop, entry)] } : {
        stdin: { contents: extraSource, resolveDir: main, sourcefile: "negative-entry.ts", loader: "ts" },
      }),
      bundle: true, write: false, treeShaking: true, platform: "node", format: "esm",
      packages: "external", logLevel: "silent", plugins: [oraclePlugin(cost)],
    });
    cost.inputs = Object.keys(result.metafile!.inputs).length;
    cost.inputBytes = Object.values(result.metafile!.inputs).reduce((total, input) => total + input.bytes, 0);
    return result.outputFiles.map((output) => output.text).join("\n");
  } finally {
    activeBundles.delete(label);
    const used = process.cpuUsage(cpu);
    console.info("production-entry-oracle cost", JSON.stringify({
      entry: label, pid: process.pid, overlap, ...cost,
      wallMs: performance.now() - started, nodeCpuMs: (used.user + used.system) / 1000,
    }));
  }
}
